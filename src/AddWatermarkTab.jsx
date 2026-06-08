import React, { useState, useRef, useEffect } from 'react';
import {
  Box, Paper, Stack, Typography, Button, IconButton, Tooltip, TextField, Select, MenuItem,
  FormControl, InputLabel, Slider, Switch, FormControlLabel, LinearProgress, Chip, Divider, Collapse,
} from '@mui/material';
import MovieIcon from '@mui/icons-material/Movie';
import ImageIcon from '@mui/icons-material/Image';
import AutoFixHighIcon from '@mui/icons-material/AutoFixHigh';
import StopIcon from '@mui/icons-material/Stop';
import PlayArrowIcon from '@mui/icons-material/PlayArrow';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import ErrorIcon from '@mui/icons-material/Error';
import { apiFetch, addWatermark, getWmStatus } from './engine.js';

const isVideo = (f) => /^video\/(mp4|quicktime)$/.test(f.type) || /\.(mp4|mov|m4v)$/i.test(f.name);

export default function AddWatermarkTab({ outputDir, onToast }) {
  const [file, setFile] = useState(null);
  const [logoFile, setLogoFile] = useState(null);
  const [text, setText] = useState('© 2026');
  const [position, setPosition] = useState('bottom-right');
  const [color, setColor] = useState('white');
  const [opacity, setOpacity] = useState(0.6);
  const [fontsize, setFontsize] = useState(0.05);
  const [logoScale, setLogoScale] = useState(0.15);
  const [tile, setTile] = useState(false);
  const [sparkle, setSparkle] = useState(false);
  const [glow, setGlow] = useState(false);
  const [shadow, setShadow] = useState(false);
  const [motion, setMotion] = useState('none');
  const [crf, setCrf] = useState(20);
  const [advOpen, setAdvOpen] = useState(false);
  const [hidden, setHidden] = useState(false);
  const [password, setPassword] = useState('');
  const [payload, setPayload] = useState('');

  const [status, setStatus] = useState('idle'); // idle|processing|done|error|cancelled
  const [progress, setProgress] = useState(0);
  const [info, setInfo] = useState('');
  const [savedPath, setSavedPath] = useState('');
  const [hiddenBytes, setHiddenBytes] = useState(null);
  const [available, setAvailable] = useState(true);

  const fileRef = useRef(null);
  const logoRef = useRef(null);
  const abortRef = useRef(null);
  const busy = status === 'processing';

  useEffect(() => { getWmStatus().then((s) => setAvailable(!!(s && s.available === true))).catch(() => setAvailable(false)); }, []);

  const pickFile = (e) => {
    const f = (e.target.files || [])[0];
    e.target.value = '';
    if (f && isVideo(f)) { setFile(f); setStatus('idle'); setSavedPath(''); }
    else if (f) onToast?.('Chỉ nhận video MP4/MOV');
  };
  const pickLogo = (e) => { const f = (e.target.files || [])[0]; e.target.value = ''; if (f) setLogoFile(f); };

  const run = async () => {
    if (!file || busy) return;
    if (!text.trim() && !logoFile) { onToast?.('Cần nhập chữ hoặc chọn logo'); return; }
    if (hidden && (!password.trim() || !payload.trim())) { onToast?.('Watermark ẩn cần mật khẩu và nội dung'); return; }
    setStatus('processing'); setProgress(0.05); setInfo(''); setSavedPath(''); setHiddenBytes(null);
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const opts = {
        text: text.trim(), color, opacity, position, fontsize_ratio: fontsize,
        shadow, rotate: 0, tile, sparkle, glow, motion, motion_interval: 3,
        logo_scale: logoScale, logo_opacity: 1.0, crf, preset: 'medium',
        hidden, password, payload,
      };
      const out = await addWatermark(file, logoFile, opts, (p, i) => { setProgress(p); setInfo(i); }, controller.signal);
      setStatus('done'); setProgress(1); setSavedPath(out.path); setHiddenBytes(out.hiddenBytes ?? null);
      onToast?.('Đã thêm watermark — đã lưu: ' + out.name
        + (out.hiddenBytes ? ` · watermark ẩn ${out.hiddenBytes} byte (ghi lại để trích xuất)` : ''));
    } catch (e) {
      const msg = e?.message || 'Thất bại';
      const cancelled = /cancel/i.test(msg);
      setStatus(cancelled ? 'cancelled' : 'error'); setInfo(cancelled ? 'Đã huỷ' : msg);
    } finally { abortRef.current = null; }
  };

  const stop = () => { try { abortRef.current?.abort(); } catch (_) { /* ignore */ } };
  const openResult = () => {
    if (!savedPath) return;
    const fd = new FormData(); fd.append('path', savedPath);
    apiFetch('/api/open-path', { method: 'POST', body: fd }).catch(() => {});
  };

  const pct = Math.round(progress * 100);

  return (
    <Box sx={{ maxWidth: 760, mx: 'auto', px: 3, py: 3, width: '100%' }}>
      {!available && (
        <Paper variant="outlined" sx={{ p: 1.5, mb: 2, borderColor: 'warning.main' }}>
          <Typography variant="body2" color="warning.main">
            Tính năng thêm watermark cần <b>ffmpeg + numpy + Pillow</b> (chạy bằng <b>update.bat</b>). Hiện chưa khả dụng.
          </Typography>
        </Paper>
      )}

      <Paper
        variant="outlined"
        onClick={() => !busy && fileRef.current?.click()}
        sx={{ p: file ? 2 : 5, mb: 2.5, textAlign: 'center', cursor: busy ? 'default' : 'pointer',
          borderStyle: 'dashed', borderWidth: 2 }}
      >
        <MovieIcon sx={{ fontSize: file ? 28 : 42, color: 'primary.main', opacity: 0.9 }} />
        <Typography sx={{ fontWeight: 600, mt: 1 }}>
          {file ? file.name : 'Bấm để chọn video (MP4 / MOV)'}
        </Typography>
        <input ref={fileRef} type="file" hidden accept="video/mp4,video/quicktime,.mp4,.mov,.m4v" onChange={pickFile} />
      </Paper>

      <Stack spacing={2}>
        <TextField label="Chữ watermark" size="small" fullWidth value={text}
          onChange={(e) => setText(e.target.value)} placeholder="© ACME 2026 / @username" disabled={busy} />

        <Stack direction="row" spacing={2} sx={{ flexWrap: 'wrap', rowGap: 2 }}>
          <FormControl size="small" sx={{ minWidth: 170 }} disabled={busy}>
            <InputLabel id="pos">Vị trí</InputLabel>
            <Select labelId="pos" label="Vị trí" value={position} onChange={(e) => setPosition(e.target.value)}>
              <MenuItem value="bottom-right">Dưới phải</MenuItem>
              <MenuItem value="bottom-left">Dưới trái</MenuItem>
              <MenuItem value="top-right">Trên phải</MenuItem>
              <MenuItem value="top-left">Trên trái</MenuItem>
              <MenuItem value="center">Giữa</MenuItem>
              <MenuItem value="random">Ngẫu nhiên</MenuItem>
            </Select>
          </FormControl>
          <FormControl size="small" sx={{ minWidth: 170 }} disabled={busy}>
            <InputLabel id="mo">Chuyển động</InputLabel>
            <Select labelId="mo" label="Chuyển động" value={motion} onChange={(e) => setMotion(e.target.value)}>
              <MenuItem value="none">Tĩnh</MenuItem>
              <MenuItem value="random">Nhảy ngẫu nhiên</MenuItem>
              <MenuItem value="bounce">Nảy (DVD)</MenuItem>
            </Select>
          </FormControl>
          <TextField label="Màu" size="small" sx={{ width: 130 }} value={color}
            onChange={(e) => setColor(e.target.value)} placeholder="white / #ff0000" disabled={busy} />
        </Stack>

        <Box>
          <Typography variant="caption" color="text.secondary">Độ mờ: {opacity.toFixed(2)}</Typography>
          <Slider size="small" min={0.05} max={1} step={0.05} value={opacity} disabled={busy}
            onChange={(_, v) => setOpacity(v)} />
        </Box>
        <Box>
          <Typography variant="caption" color="text.secondary">Cỡ chữ (theo chiều cao video): {fontsize.toFixed(2)}</Typography>
          <Slider size="small" min={0.02} max={0.15} step={0.005} value={fontsize} disabled={busy}
            onChange={(_, v) => setFontsize(v)} />
        </Box>

        <Stack direction="row" sx={{ flexWrap: 'wrap' }}>
          <FormControlLabel control={<Switch checked={tile} onChange={(e) => setTile(e.target.checked)} disabled={busy} />} label="Lưới chéo" />
          <FormControlLabel control={<Switch checked={sparkle} onChange={(e) => setSparkle(e.target.checked)} disabled={busy} />} label="Spark ✦" />
          <FormControlLabel control={<Switch checked={glow} onChange={(e) => setGlow(e.target.checked)} disabled={busy} />} label="Glow" />
          <FormControlLabel control={<Switch checked={shadow} onChange={(e) => setShadow(e.target.checked)} disabled={busy} />} label="Đổ bóng" />
        </Stack>

        <Stack direction="row" spacing={2} alignItems="center" sx={{ flexWrap: 'wrap', rowGap: 1 }}>
          <Button variant="outlined" size="small" startIcon={<ImageIcon />} onClick={() => logoRef.current?.click()} disabled={busy}>
            {logoFile ? 'Logo: ' + logoFile.name : 'Chọn logo (PNG, tuỳ chọn)'}
          </Button>
          {logoFile && <Button size="small" color="inherit" onClick={() => setLogoFile(null)} disabled={busy}>Bỏ logo</Button>}
          <input ref={logoRef} type="file" hidden accept="image/png,image/webp,image/jpeg" onChange={pickLogo} />
          <FormControl size="small" sx={{ minWidth: 150 }} disabled={busy}>
            <InputLabel id="q">Chất lượng</InputLabel>
            <Select labelId="q" label="Chất lượng" value={crf} onChange={(e) => setCrf(e.target.value)}>
              <MenuItem value={23}>Nhẹ (CRF 23)</MenuItem>
              <MenuItem value={20}>Tiêu chuẩn (CRF 20)</MenuItem>
              <MenuItem value={18}>Cao (CRF 18)</MenuItem>
            </Select>
          </FormControl>
        </Stack>
        {logoFile && (
          <Box>
            <Typography variant="caption" color="text.secondary">Cỡ logo (theo bề ngang): {logoScale.toFixed(2)}</Typography>
            <Slider size="small" min={0.05} max={0.5} step={0.01} value={logoScale} disabled={busy} onChange={(_, v) => setLogoScale(v)} />
          </Box>
        )}

        <Divider />
        <Button size="small" color="inherit" onClick={() => setAdvOpen((o) => !o)} sx={{ alignSelf: 'flex-start' }}>
          {advOpen ? '▾' : '▸'} Watermark ẩn (nâng cao)
        </Button>
        <Collapse in={advOpen}>
          <Stack spacing={1.5} sx={{ pl: 1 }}>
            <FormControlLabel control={<Switch checked={hidden} onChange={(e) => setHidden(e.target.checked)} disabled={busy} />}
              label="Nhúng watermark ẩn (bền qua re-encode)" />
            <Stack direction="row" spacing={2} sx={{ flexWrap: 'wrap', rowGap: 1 }}>
              <TextField label="Mật khẩu" size="small" value={password} onChange={(e) => setPassword(e.target.value)} disabled={busy || !hidden} />
              <TextField label="Nội dung ẩn (payload)" size="small" value={payload} onChange={(e) => setPayload(e.target.value)} disabled={busy || !hidden} />
            </Stack>
            <Typography variant="caption" color="text.secondary">
              Để trích xuất sau này cần đúng mật khẩu + số byte (in ra khi nhúng). Watermark ẩn xử lý từng khung nên chậm hơn.
            </Typography>
          </Stack>
        </Collapse>

        <Stack direction="row" spacing={1.5} alignItems="center" sx={{ mt: 1 }}>
          {!busy ? (
            <Button variant="contained" startIcon={<AutoFixHighIcon />} onClick={run} disabled={!file || !available}>
              Thêm watermark &amp; Lưu
            </Button>
          ) : (
            <Button variant="contained" color="error" startIcon={<StopIcon />} onClick={stop}>Dừng</Button>
          )}
          {status === 'done' && (
            <Tooltip title="Mở video kết quả">
              <IconButton color="success" onClick={openResult}><PlayArrowIcon /></IconButton>
            </Tooltip>
          )}
          {status === 'done' && <Chip size="small" color="success" icon={<CheckCircleIcon />} label="Xong" />}
          {status === 'error' && <Chip size="small" color="error" icon={<ErrorIcon />} label={info || 'Lỗi'} />}
          {status === 'cancelled' && <Chip size="small" color="warning" label="Đã huỷ" />}
        </Stack>

        {busy && (
          <Box>
            <LinearProgress variant="determinate" value={pct} sx={{ height: 6, borderRadius: 3 }} />
            <Typography variant="caption" color="text.secondary">{info || 'Đang xử lý…'} {pct}%</Typography>
          </Box>
        )}
        {savedPath && (
          <Typography variant="caption" color="text.secondary" noWrap title={savedPath}>➜ {savedPath}</Typography>
        )}
        {hiddenBytes ? (
          <Typography variant="caption" color="warning.main" sx={{ display: 'block' }}>
            Watermark ẩn: <b>{hiddenBytes} byte</b> — ghi lại số này + mật khẩu để trích xuất sau.
          </Typography>
        ) : null}
        <Typography variant="caption" color="text.secondary">
          File lưu vào: <b>{outputDir || '…'}</b>
        </Typography>
      </Stack>
    </Box>
  );
}
