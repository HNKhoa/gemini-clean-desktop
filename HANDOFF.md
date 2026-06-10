# HANDOFF — Gemini Clean (gemini-clean-desktop)

> Tài liệu bàn giao cho phiên làm việc khác. Bao quát **cả hai tính năng**: **Xoá watermark** và **Thêm watermark**.
> Cập nhật tại commit `03e9d16` (nhánh `main`, remote `github.com/HNKhoa/gemini-clean-desktop`).

---

## ⚠️ Đọc trước tiên (3 điều dễ hiểu sai)

1. **`CLAUDE.md` trong thư mục KHÔNG mô tả dự án này.** File đó nói về một app "Studio Downloader" (Python/PyWebView). **Bỏ qua nó.** Dự án thật là **Gemini Clean** — Electron + React/MUI (Vite) + Python FastAPI. Theme dùng **cam `#e0863f`**, không phải indigo.
2. **Backend KHÔNG tự xoá watermark.** Việc xoá watermark ảnh/video chạy trong **engine JS phía trình duyệt** (Canvas/WebCodecs). Backend FastAPI chỉ: lưu file đã xử lý, settings/history (SQLite), mở thư mục, và chạy 2 loại job nền (**AI inpaint** + **Thêm watermark**).
3. **Hai chế độ "nặng" (AI inpaint + Thêm watermark) chỉ chạy ở bản nguồn (`update.bat`)**, không có trong bản portable `.exe` (PyInstaller không bundle onnxruntime/numpy/Pillow). Khi không khả dụng, UI tự hiện cảnh báo và disable nút.

---

## 1. Kiến trúc & cách chạy

```
Electron (electron/main.cjs)  →  cửa sổ + vòng đời + spawn/kill backend
React + MUI (src/, Vite)      →  UI 2 tab; theme dark cam #e0863f
Engine JS (public/engine/)    →  bộ xoá watermark đã kiểm chứng, nạp như ES module THÔ (Vite KHÔNG bundle)
Python FastAPI (backend/)     →  /api: save, settings, history, open/reveal, AI inpaint job, add-watermark job
```

**3 chế độ chạy** (electron/main.cjs, cờ `DEV = process.env.ELECTRON_DEV === '1'`):
- **Dev** (`npm run dev`): Vite :5173, backend do npm chạy (`python backend/server.py`), Electron load `http://localhost:5173`, `/api` proxy về :8000.
- **Local prod** (`npm start`): Electron spawn `python backend/server.py`, phục vụ `./dist`, **port động** (getFreePort, fallback 8000), truyền `GCD_PORT` + `GCD_DIST_DIR` qua env.
- **Packaged** (`.exe`): chạy `gcd-backend.exe` (PyInstaller) + `app-dist`, đều là `extraResources` cạnh app.

**Script `.bat` (chạy ở thư mục gốc, Windows):**
| Script | Việc làm |
|---|---|
| `update.bat` | **Dùng hằng ngày.** npm install → pip install requirements.txt (fatal) → nếu có `onnxruntime-gpu` thì GIỮ NGUYÊN, ngược lại cài `requirements-ai.txt` **non-fatal** → `npm run build` → `npm start`. Phải giữ cửa sổ console mở khi dùng. |
| `run.bat` | Mở nhanh, **không** rebuild/cài lại (cần sẵn `node_modules` + `dist`). |
| `setup-gpu.bat` | **Phát hiện card + menu chọn**: [1] NVIDIA CUDA (`requirements-ai-cuda.txt`), [2] AMD/Intel DirectML (`requirements-ai.txt`), [3] CPU (`onnxruntime` thuần), [0] thoát. Gỡ cả 3 gói onnxruntime trước. ⚠️ Chỉ **CUDA** tăng tốc thật cho LaMa; AMD/Intel/CPU đều chạy CPU (DirectML không chạy được mô hình). Tự gợi ý theo card (NVIDIA ưu tiên). **Chế độ tự động (deploy nhiều máy):** truyền tham số `auto` (tự chọn theo card) / `nvidia`\|`cuda` / `amd`\|`intel`\|`dml` / `cpu` → bỏ menu + bỏ `pause` (đặt cờ `NONINTERACTIVE`); `help`/`/?` in hướng dẫn. Vẫn cần thư mục dự án (đọc `backend\requirements-ai*.txt`). |
| `package.bat` | Build EXE độc lập: PyInstaller → `gcd-backend.exe`, electron-builder portable. Cần **Windows Developer Mode ON** (nếu OFF → fallback `release\win-unpacked`). |
| `push.bat` | git add -A → commit (hỏi message) → git push. |

**Lệnh npm:** `dev`, `dev:vite`, `dev:backend`, `dev:electron`, `build` (vite build → `dist/`), `start` (electron .), `package`.

**Yêu cầu môi trường:** Node 18+; Python 3.9+ cho lõi, **3.10+ cho AI inpaint** (onnxruntime không có wheel 3.9); **ffmpeg + ffprobe trên PATH** cho AI inpaint và Thêm watermark.

---

## 2. Backend (`backend/server.py`) — chung cho cả 2 tính năng

- **Cổng/đường dẫn:** `PORT = env GCD_PORT (mặc định 8000)`; `DIST_DIR = env GCD_DIST_DIR | BASE_DIR/dist`; `DATA_DIR = ~/.gemini-clean`; `DB_PATH = DATA_DIR/app.db`; `DEFAULT_OUTPUT_DIR = ~/Downloads/GeminiClean`; `MODELS_DIR = DATA_DIR/models`.
- **CSRF guard (`api_guard`):** mọi `/api/*` (trừ OPTIONS/HEAD) **phải có header `X-GCD: 1`**, nếu không → **403 trước mọi side-effect**. ⚠️ Cả các GET (settings, history, ai-status, poll job) cũng cần header — `curl` test phải tự thêm.
- **`no_store_dynamic`:** đặt `Cache-Control: no-store` cho mọi response trừ `/assets/*` (asset Vite có hash nội dung mới được cache).
- **DB (SQLite, `~/.gemini-clean/app.db`):** `settings(key,value)`, `history(id,name,path,kind,size,created_at)`.
- **Static:** `app.mount("/", StaticFiles(DIST_DIR, html=True))` mount **cuối cùng** nên `/api` ưu tiên. Chỉ mount nếu `DIST_DIR` tồn tại.
- **uvicorn pinned:** `loop='asyncio', http='h11', ws='none'` — chủ ý cho bản PyInstaller; **đừng đổi** kẻo vỡ packaged build.

**Helper quan trọng:**
- `safe_name()`: lọc ký tự `[<>:"/\|?*]` → `_`; rỗng → `clean_{timestamp}.png`.
- `unique_path()`: tránh đè — `name`, `name (1)`, `name (2)`…
- `_move()`: `os.replace` rồi fallback `shutil.move` (di chuyển khác ổ đĩa).
- `validate_output_dir()`: từ chối UNC (`\\`/`//`), path tương đối, thư mục Windows, thư mục Startup; rỗng → trả về `DEFAULT_OUTPUT_DIR` (im lặng reset).
- `_safe_font()`: chặn `/`, `\`, `..`; tự thêm `.ttf`; → Pillow resolve trong `C:\Windows\Fonts`, fallback Arial.

**Endpoint dùng chung:**
| Method | Path | Ghi chú |
|---|---|---|
| GET | `/api/health` | `{ok:true}` (Electron poll khi khởi động, có X-GCD). |
| GET/POST | `/api/settings` | `{output_dir, ai_inpaint('0'/'1'), ai_quality}`. ai_quality ∈ `standard/high/near_lossless`. |
| POST | `/api/save` | multipart `file` + `name` + `kind` (lưu byte đã sạch). **Đọc nguyên file vào RAM.** |
| GET | `/api/history` | `{items:[...]}` mới nhất trước. |
| POST | `/api/open-output` | Mở thư mục output. |
| POST | `/api/open-path` | Mở 1 file (phải nằm trong output dir, else 403). |
| POST | `/api/reveal-path` | Mở thư mục + **bôi chọn** đúng file (`explorer /select`). Cùng kiểm tra chứa-trong-output. |

**Job nền:** `ai_jobs` / `wm_jobs` là dict in-memory (không khoá, giả định 1 người dùng). Mỗi loại 1 `Semaphore(1)` riêng (`_ai_sema`, `_wm_sema`) → **AI và watermark CÓ thể chạy đồng thời**, nhưng 2 job cùng loại thì nối tiếp. Job kết thúc bị evict sau **600 giây** (`threading.Timer`) → poll trễ sẽ 404.

---

## 3. TÍNH NĂNG A — XOÁ WATERMARK

### 3.1 Đường đi chính (chạy trong renderer, không upload)
`src/App.jsx` (tab "Xoá watermark") → `src/engine.js` → engine JS ở `public/engine/`.

- **Ảnh:** `processImage(file)` → SDK `removeWatermarkFromImageData(..., {engine, enableMultiPass:true, enableCleanup:true})` → **reverse-alpha**: gốc = `(observed − α·255)/(1−α)` với alpha map nhúng sẵn. ⚠️ `processImage` **không throw** khi thất bại — trả về ảnh GỐC với `applied:false` (kết quả "thành công" có thể là ảnh chưa đổi). Sau đó `saveToDisk(blob, name, 'image')`.
- **Video (thường):** `processVideo(file, onProgress, signal, maxOutputDimension=1920)`:
  1. `detectVideoWatermarkBox(file)` — NCC + **trung bình nhiều khung** (frac 0.12…0.96) để nền động bị mờ còn watermark tĩnh vẫn nét; ngưỡng raw NCC ≥ **0.42** mới nhận; fallback 1 khung 0.5; trả `null` nếu không thấy.
  2. `calibrateVideoGain(file, box)` — quét gain 0.30→2.21 (bước 0.05), chọn gain ít làm tăng near-black nhất; có thể trả `null` → video-service dùng mặc định `VIDEO_INTENSITY = 0.62`.
  3. `processVideoWatermarkMp4(file, ...)` (WebCodecs, `public/engine/video-mp4-service.js`) trả **Blob** → `saveToDisk`.
- **Video (AI inpaint):** khi bật toggle VÀ backend khả dụng → `processVideoAI(file, ...)` upload + poll; backend **tự lưu file** và trả `{path}` (KHÔNG gọi `saveToDisk`).

### 3.2 AI inpaint LaMa (`backend/lama_video.py`)
Pipeline: ffmpeg decode mọi khung → PNG → phát hiện watermark **1 lần** (NCC trên trung bình ≤8 khung, template `lama_alpha96.f32` 96×96 + **prior Gaussian góc dưới-phải**) → LaMa inpaint cửa sổ quanh logo từng khung qua ONNX Runtime → ffmpeg encode libx264 + **copy audio nguyên gốc**.

- **Model:** `opencv/inpainting_lama` ONNX (Apache-2.0), input image `1×3×512×512` BGR `/255` + mask `1×1×512×512` (1=inpaint). Tải 1 lần về `~/.gemini-clean/models/inpainting_lama.onnx` (revision ghim + **SHA256** `7df918ac…fdf2`, kích thước 92 591 623 B). **Không** nằm trong repo.
- **Provider (`get_session`):** thử lần lượt **CUDA → DirectML → CPU**. Mỗi ứng viên phải qua `_warmup()` (1 inference giả) MỚI được chọn. **DirectML KHÔNG chạy được LaMa** (lỗi "parameter is incorrect" ở FFC MatMul lúc *chạy*) → warm-up là chốt chặn bắt buộc; bỏ nó đi sẽ chọn nhầm provider hỏng. `_preload_cuda()` gọi `ort.preload_dlls()` (chỉ có ở onnxruntime-gpu) để nạp CUDA libs từ wheel pip.
- **Chất lượng (`QUALITY` dict):** `standard→(crf 18, medium)`, `high→(16, slow)`, `near_lossless→(12, slow)`. CRF 12 là trần thực tế (nguồn đã lossy).
- **Audio (`_encode`):** thử `-c:a copy` trước (không mất chất lượng); chỉ fallback `aac 192k` nếu copy lỗi.
- **fps:** ưu tiên `avg_frame_rate` (không phải `r_frame_rate`) để khớp duration + đồng bộ audio với video VFR.
- **Cửa sổ ngữ cảnh:** `ctx = min(min(W,H), max(256, size*3))`, ép chẵn; gốc cửa sổ kẹp để mask không âm/tràn trên video độ phân giải cao.
- **Không có watermark:** giữ nguyên gốc **lossless** bằng `ffmpeg -map 0 -c copy` (không re-encode).
- **Hủy:** kiểm `should_cancel()` mỗi khung khi inpaint (KHÔNG kiểm trong lúc ffmpeg decode/encode).

**Endpoint AI:** `POST /api/process-video-ai` (stream upload xuống đĩa) → `{job_id}`; `GET /api/ai-job/{id}`; `POST /api/ai-cancel/{id}`; `GET /api/ai-status` (`{available, model_ready, ffmpeg, providers, enabled}`). Output: `clean_<tên>.mp4`, history `kind='video'`.

---

## 4. TÍNH NĂNG B — THÊM WATERMARK

### 4.1 UI (`src/AddWatermarkTab.jsx`)
- **Bố cục 2 cột** (flex, md trở lên): **cài đặt bên trái** (order 1), **video + xem trước "review" bên phải** (order 2), cột phải **sticky**. Màn hẹp → xếp dọc, preview lên trên.
- **Khung xem trước (canvas):** nạp 1 khung video bằng `grabPreviewFrame` (client-side, không upload); **thanh trượt chọn khung**; **bấm/kéo để ghim vị trí** (customXY); **phím mũi tên** dịch chuyển (Shift = 10px); **ARIA** + `role=application`. `loadSeqRef` chống nạp khung lệch thứ tự.
- **Resize handle:** chỉ hiện ở **chế độ ghim (custom)**. Mỗi phần (chữ / logo) có ô vuông góc dưới-phải riêng → resize độc lập (chữ→`fontsize`, logo→`logoScale`), **kẹp trong khung** (wBudget/hBudget) nên không lọt ra ngoài. `handleHit` test chữ trước (vẽ trên).
- **`placeable = motion==='none' && !tile`** — chỉ khi đó vị trí cố định / pin mới có tác dụng; motion/tile thì backend bỏ qua vị trí (UI gửi `effPos` + custom rỗng).
- **`textTileBox()` + `strokePxFor()`** là **nguồn chân lý dùng chung** giữa preview và backend (mirror Pillow `_render_text_tile` + `_tile_onto`, gồm giãn stroke 2·sw mỗi chiều, pitch tile `floor(1.6×)`). `MARGIN=24` **phải khớp** `geometry.compute_xy`.
- **`cssToHex()`** chuẩn hoá màu bằng mẹo **2 sentinel** (đừng "đơn giản hoá" về 1 fillStyle — màu sai sẽ giả dạng đen/trắng).
- **Mẫu thương hiệu `BRANDS`** (7): Veo/Sora/CapCut/TikTok/Kling/Pika/Runway — **tất cả vị trí dưới-phải** (theo nghiên cứu web); Veo `motion 'random'`, Sora & TikTok `'bounce'`, còn lại `'none'`; mỗi mẫu có `note` (tooltip, kèm nguồn + độ tin cậy; Runway thấp).
- **`BRAND_LOGOS`** (3, bundle ở `public/brand/`, phục vụ tại `/brand/...`): KT AI trắng/đen + logo đầy đủ. `applyBrandLogo` dùng **`fetch('/brand/...')` thường (KHÔNG apiFetch — asset tĩnh)**, set text rỗng, position dưới-phải, opacity 0.65.
- **Chọn cả thư mục logo:** input ẩn có `webkitdirectory` (gán bằng effect); `pickLogoDir` lọc png/jpg/webp, revoke URL batch cũ, giữ tối đa 60 ảnh thành lưới thumbnail bấm chọn.
- **Font:** `FONTS` (13) — token là tên file font Windows; `fontDefOf` lấy `{css, weight}` cho preview; backend fallback Arial.
- **Viền chữ (sharpness):** `outlineWidth` (0..0.15) → `strokePxFor(sizePx, outline)` (sizePx tính từ `frame.height`, fallback 1080); `outlineColor` tự tương phản theo `hexLuminance`.
- **Tên file lưu (`name_mode`):** `name_text` (tên gốc + chữ wm, mặc định) / `text_only` (chỉ chữ wm) / `wm_prefix` (`wm_` + tên gốc).
- **Mở thư mục kết quả:** nút `openFolder` → `/api/reveal-path` (bôi chọn file), hoặc `/api/open-output` nếu chưa có file.
- **Watermark ẩn (nâng cao):** Collapse; cần mật khẩu + payload; sau khi xong hiện `hiddenBytes` (phải ghi lại để trích xuất).
- **`run()` gửi mọi key:** text, color, opacity, position(effPos), font, custom_x/y, fontsize_ratio, **stroke_width/stroke_color**, shadow, rotate:0, tile, sparkle, glow, motion, motion_interval:3, logo_scale, **logo_opacity=opacity** (1 slider điều khiển cả chữ + logo), crf, **name_mode**, hidden, password, payload.

### 4.2 Backend route (`/api/add-watermark`, `backend/server.py`)
- Form params đầy đủ (mặc định): `text=''`, `color='white'`, `opacity='0.5'`, `position='bottom-right'`, `fontsize_ratio='0.05'`, `font='arial.ttf'`, `custom_x/custom_y=''`, `stroke_width='0'`, `stroke_color='black'`, `shadow/rotate/tile/sparkle/glow`, `motion='none'`, `motion_interval='3'`, `seed`, `logo_scale='0.15'`, `logo_opacity='1.0'`, `crf='20'`, `preset='medium'`, `name_mode='name_text'`, `hidden/password/payload`, `logo` (File optional).
- `_run_wm_job`: hidden mà thiếu password/payload → **fail loud**; màu chữ sai → lỗi `Màu không hợp lệ`; màu viền sai → **fallback đen** (không fail). Pipeline: `VisibleWatermarker(...).apply()`; nếu hidden → render visible ra tạm rồi `InvisibleWatermarker(password).embed(..., should_cancel=...)`, lưu `hidden_bytes`.
- **Tên file (`name_mode`)**: `stem=safe_name(tên gốc)`; `wm = sanitize(text)[:60]` (lọc riêng, KHÔNG dùng safe_name vì nó fallback `.png`). `text_only`→`{wm}.mp4`; `name_text`→`{stem}_{wm}.mp4` (hoặc `{stem}_wm.mp4` nếu không có chữ); else→`wm_{stem}.mp4`. Sau đó `unique_path`.
- Endpoint: `GET /api/wm-job/{id}`, `POST /api/wm-cancel/{id}`, `GET /api/wm-status` (`{available, ffmpeg}`). Output history `kind='video'`.
- ⚠️ Bất đối xứng hủy: `_run_wm_job` chỉ kiểm `job['cancel']` (job AI còn nhận thêm exception tên `Cancelled`).

### 4.3 Gói `backend/watermark/` (toolkit)
- **`VisibleWatermarker`** (dataclass): `TextSpec`(font='arial.ttf', fontsize_ratio=0.05, color='white', opacity=0.5, stroke_width=0, stroke_color='black', shadow, sparkle, glow, tile, tile_spacing=1.6, rotate) + `LogoSpec`(scale=0.15 theo bề ngang, opacity=1.0). `position` presets + `custom_xy`, `margin=24`, `motion none/random/bounce`, `crf=20`. **`engine='auto'` luôn → 'pillow'** (drawtext/ffmpeg native là opt-in; motion!='none' override engine/tile/vị trí).
- **`compute_xy`**: presets `top-left/top-right/bottom-left/bottom-right/center/custom`; 'custom' cần `custom_xy` (trả int trực tiếp, **không kẹp** → UI phải tự kẹp).
- **`InvisibleWatermarker`** (DWT Haar → DCT khối → QIM/SVD trên luma): `embed(in, out, message, should_cancel=None)` → stats `{psnr, n_frames, n_bytes, backend}`; `extract(in, n_bytes)`. ⚠️ Trích xuất cần **3 thứ khớp tuyệt đối**: password, `n_bytes`, và cfg (method/block_size/coef/strength/every_nth). Dung lượng **theo từng khung**: bit payload `(3+len)*8` phải lọt `(H//2//bs)*(W//2//bs)` khối. Yêu cầu **W/H chẵn**. Haar luôn pure-numpy để bit-exact đa máy.
- **`video_io`**: `probe()` → VideoInfo(width,height,fps,duration,n_frames,has_audio,pix_fmt); `FrameWriter` (libx264, audio `-c:a copy -shortest`); `read_yuv420p_frames` (cần dim chẵn). `resolve_ffprobe` **không** có fallback imageio-ffmpeg.

---

## 5. Engine JS (`src/engine.js` + `public/engine/`)

- **Nạp runtime, KHÔNG bundle:** các URL (`SDK_URL`, `VIDEO_SERVICE_URL`, `ALPHA_URL`, `BLEND_URL`, `METRICS_URL`, `ADAPTIVE_URL`) là **biến const** truyền vào `import(/* @vite-ignore */ URL)` — giữ nguyên kiểu này, đừng inline literal hay bỏ comment, kẻo Vite bundle làm hỏng hợp đồng `/engine` (file từ `public/` ở dev, `dist/` ở prod).
- **Hàm export (tên chính xác):** `getSdk, getEngine, getVideoService, grabPreviewFrame, detectVideoWatermarkBox, calibrateVideoGain, classifyMediaFile, baseName, processImage, processVideo, API_HEADER, apiFetch, processVideoAI, getAiStatus, getWmStatus, addWatermark, saveToDisk`. (Bộ dò NCC nội bộ tên `locateSparkle`, KHÔNG phải `locateVideoWatermark`.)
- **`API_HEADER = {'X-GCD':'1'}`** — **mọi** gọi `/api` phải qua `apiFetch` (hoặc tự thêm header) nếu không backend 403.
- `addWatermark` map `hidden_bytes` (snake) → `hiddenBytes` (camel).
- **Hủy job AI/wm** phải gọi cancel POST (`/api/ai-cancel`, `/api/wm-cancel`); chỉ abort AbortSignal **chỉ dừng vòng poll**, backend vẫn chạy và vẫn lưu file.
- `embeddedAlphaMaps.js` chỉ có size **48 và 96** (base64 dòng ~12K/~49K ký tự — công cụ đọc theo dòng dễ nghẹn).

---

## 6. Lịch sử commit gần đây (ngữ cảnh tính năng)

```
03e9d16 Add-watermark: logo folder picker, output naming, open-folder, logo size   ← mới nhất
2c2cf73 Two-column Add-watermark layout: settings left, preview right
3cde973 Bundle Xưởng AI brand logos as one-click watermarks
1812fa2 Sharper watermark text: outline + near-lossless + RGB colour picker
e9cb3c4 Add font selector for watermark text
86c7bf9 Add corner-resize handles + research-backed brand watermark positions
dba7afe Add visual placement preview + brand templates to Add-watermark tab
a36fd7a Harden Add-watermark per adversarial review (7 findings)
48b18ff Add 'Add watermark' tab (visible overlay + invisible payload)
e12481f..e7bdb8f  AI inpaint (LaMa) + quality selector + CUDA + DirectML→CPU fallback
22c8ff6..1655802  Video reverse-alpha: gain calibration, adaptive soften, auto-detect, hardening
```

---

## 7. Quy trình kiểm chứng đã dùng (giữ kỷ luật này)

- **Build:** `npm run build` phải pass (JSX cân bằng).
- **Backend smoke test offline:** sinh video bằng ffmpeg `lavfi`, chạy thẳng `watermark`/`lama_video`, trích khung bằng ffmpeg, đo bằng numpy/PIL (đã dùng cho: custom_xy, font, viền chữ, brand-logo). **Xoá file test + `__pycache__` sau khi xong.**
- **Kiểm UI thật:** tạo `.claude/launch.json` tạm (`python backend/server.py`, port 8000), dùng Preview MCP `preview_start` → `preview_eval` (chuyển tab/scroll) → `preview_screenshot` / kiểm DOM → `preview_stop` → **xoá launch.json tạm**.
- **Review đối kháng:** với thay đổi logic phức tạp, chạy Workflow nhiều agent (review theo chiều → verify từng phát hiện) rồi sửa các finding đã xác nhận. Đã làm cho: tab thêm watermark (7), preview+brand (9), resize+brand (6).

---

## 8. Bẫy đã biết / bất biến phải giữ

- `MARGIN=24` (UI) **phải** khớp `geometry.compute_xy` margin mặc định, nếu lệch preview/preset trôi khỏi export.
- `textTileBox`/`strokePxFor`/tile-pitch mirror **chính xác** Pillow — sửa 1 bên là vỡ "thấy sao xuất vậy".
- `stroke_width` gửi backend tính từ **chiều cao khung preview** (giả định = chiều cao video xuất).
- `custom_xy`/`position` chỉ có tác dụng khi `motion==='none' && !tile`.
- 1 slider opacity điều khiển **cả** chữ và logo (`opacity` + `logo_opacity=opacity`).
- `_model_ready` chỉ kiểm **kích thước** (sai số 1 MiB), KHÔNG kiểm SHA256 (chỉ kiểm lúc tải).
- `open-path`/`reveal-path` kiểm chứa-trong-output **tại thời điểm gọi** — đổi output dir trong settings làm các path history cũ ngoài thư mục mới thành 403.
- `*.exe` bị gitignore — `gcd-backend.exe` luôn là artifact build cục bộ (`package.bat`), không có trong repo; `npm run package` đơn lẻ sẽ fail nếu chưa build exe.
- Bản portable: AI inpaint + Thêm watermark **không khả dụng** (cần `update.bat`).
- Trên Windows phải `taskkill /T /F` để diệt backend (PyInstaller onefile sinh tiến trình con; `proc.kill()` để sót server giữ port + endpoint ghi).
- `processImage` không throw khi fail (trả ảnh gốc `applied:false`); phát hiện hủy dựa trên regex `/cancel/i` trong message — đừng đổi message lỗi.

---

## 9. Hạn chế trung thực (theo README)

- Chỉ xoá watermark **hiển thị**; dấu vô hình **SynthID** vẫn còn.
- Reverse-alpha **gần đúng** trên nền phức tạp/sắc nét; muốn sạch tuyệt đối dùng **AI inpaint** (chậm trên CPU; DirectML không chạy được, chỉ CUDA hoặc CPU).
- Video cần **WebCodecs** (Electron có sẵn).
- Watermark Gemini biến thể mới `2816×1536` ('20260520') chưa xử lý đặc biệt.
- Watermark **di chuyển/động** không được xử lý (cả dò xoá lẫn AI giả định watermark tĩnh).

---

## 10. Việc còn để ngỏ / gợi ý kế tiếp

- Không có việc dở dang. Các yêu cầu gần nhất (preview + brand thật + resize + font + viền + bảng màu RGB + bố cục 2 cột + folder logo + đặt tên file + mở thư mục) đã xong, kiểm chứng và push (`03e9d16`).
- Ý tưởng có thể làm tiếp (người dùng từng gợi ý): nhớ logo/thư mục mặc định cho lần mở sau; ô xem trước tên file sẽ lưu; nút **trích xuất watermark ẩn** (UI cho `InvisibleWatermarker.extract` cần password + n_bytes); cho chọn màu viền riêng; nạp font `.ttf` của người dùng; đưa màu thương hiệu `#006DFF` vào QUICK_COLORS.

---

## 11. Bản đồ file nhanh

```
backend/server.py            FastAPI: API, settings/history, job AI + watermark, static
backend/lama_video.py        AI inpaint LaMa (detect + ONNX + ffmpeg)
backend/lama_alpha96.f32     template 96×96 cho dò watermark (Python side)
backend/watermark/           gói thêm watermark: visible.py, invisible.py, geometry.py,
                             transform.py, payload.py, video_io.py, utils.py, cli.py
backend/requirements*.txt    core / -ai (DirectML|CPU) / -ai-cuda (NVIDIA)
src/App.jsx                  shell + tab Xoá watermark + dialog Cài đặt
src/AddWatermarkTab.jsx      tab Thêm watermark (toàn bộ UI mô tả ở mục 4.1)
src/engine.js                wrapper sang engine JS + các hàm gọi /api
src/theme.js                 theme dark cam #e0863f
public/engine/               engine xoá watermark (gwr) + mp4box/mp4-muxer + worker — KHÔNG bundle
public/brand/                3 logo thương hiệu bundle (phục vụ tại /brand/)
electron/main.cjs            cửa sổ + spawn/kill backend + 3 chế độ chạy
*.bat                        update / run / setup-gpu / package / push
```
