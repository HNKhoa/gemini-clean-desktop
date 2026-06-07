import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  AppBar, Toolbar, Typography, Box, Button, IconButton, Container, Paper, Stack,
  LinearProgress, Chip, Tooltip, Dialog, DialogTitle, DialogContent, DialogActions,
  TextField, Divider, Switch, FormControlLabel,
} from '@mui/material';
import FolderOpenIcon from '@mui/icons-material/FolderOpen';
import SettingsIcon from '@mui/icons-material/Settings';
import CloudUploadIcon from '@mui/icons-material/CloudUpload';
import ImageIcon from '@mui/icons-material/Image';
import MovieIcon from '@mui/icons-material/Movie';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import ErrorIcon from '@mui/icons-material/Error';
import AutoFixHighIcon from '@mui/icons-material/AutoFixHigh';
import StopIcon from '@mui/icons-material/Stop';
import CloseIcon from '@mui/icons-material/Close';
import RefreshIcon from '@mui/icons-material/Refresh';
import OpenInNewIcon from '@mui/icons-material/OpenInNew';
import PlayArrowIcon from '@mui/icons-material/PlayArrow';
import { apiFetch, classifyMediaFile, processImage, processVideo, processVideoAI, getAiStatus, saveToDisk } from './engine.js';

const MAX_IMAGES = 20;
const MAX_VIDEOS = 5;
const uid = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;

const BAR_COLOR = { pending: 'primary', processing: 'warning', done: 'success', error: 'error', cancelled: 'warning' };

function JobRow({ job, busy, onRemove, onOpen, onRetry }) {
  const pct = Math.round((job.progress || 0) * 100);
  const Icon = job.kind === 'video' ? MovieIcon : ImageIcon;
  const isProcessing = job.status === 'processing';
  const statusEl =
    job.status === 'done' ? <Chip size="small" color="success" icon={<CheckCircleIcon />} label={job.info || 'Xong'} />
    : job.status === 'error' ? <Chip size="small" color="error" icon={<ErrorIcon />} label={job.info || 'Lỗi'} />
    : job.status === 'cancelled' ? <Chip size="small" color="warning" label={job.info || 'Đã huỷ'} />
    : isProcessing ? <Chip size="small" color="warning" label={`Đang xử lý ${pct}%${job.info ? ' · ' + job.info : ''}`} />
    : <Chip size="small" label="Chờ" />;

  return (
    <Paper variant="outlined" sx={{ p: 1.5, mb: 1.25 }}>
      <Stack direction="row" alignItems="center" spacing={1.5}>
        <Icon sx={{ color: 'text.secondary' }} />
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Typography noWrap title={job.name} sx={{ fontWeight: 600, fontSize: 14 }}>{job.name}</Typography>
          <Box sx={{ mt: 0.5 }}>{statusEl}</Box>
          {job.savedPath && (
            <Typography noWrap title={job.savedPath} variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.5 }}>
              ➜ {job.savedPath}
            </Typography>
          )}
        </Box>
        <Stack direction="row" spacing={0.25}>
          {job.status === 'done' && (
            <Tooltip title="Mở file kết quả">
              <IconButton size="small" color="success" onClick={() => onOpen(job)}>
                {job.kind === 'video' ? <PlayArrowIcon fontSize="small" /> : <OpenInNewIcon fontSize="small" />}
              </IconButton>
            </Tooltip>
          )}
          {(job.status === 'error' || job.status === 'cancelled') && (
            <Tooltip title="Thử lại">
              <span><IconButton size="small" onClick={() => onRetry(job)} disabled={busy}><RefreshIcon fontSize="small" /></IconButton></span>
            </Tooltip>
          )}
          <Tooltip title="Xoá khỏi danh sách">
            <span><IconButton size="small" onClick={() => onRemove(job.id)} disabled={busy || isProcessing}><CloseIcon fontSize="small" /></IconButton></span>
          </Tooltip>
        </Stack>
      </Stack>
      <LinearProgress
        variant="determinate"
        value={pct}
        color={BAR_COLOR[job.status] || 'primary'}
        sx={{ mt: 1.25, height: 5, borderRadius: 3 }}
      />
    </Paper>
  );
}

export default function App() {
  const [jobs, setJobs] = useState([]);
  const [processing, setProcessing] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [outputDir, setOutputDir] = useState('');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [draftDir, setDraftDir] = useState('');
  const [toast, setToast] = useState('');

  const fileRef = useRef(null);
  const jobsRef = useRef(jobs);
  jobsRef.current = jobs;
  const cancelRef = useRef(false);   // user pressed Stop
  const abortRef = useRef(null);     // AbortController for the current video job
  const [aiInpaint, setAiInpaint] = useState(false);
  const [aiStatus, setAiStatus] = useState(null);
  const [aiAvailable, setAiAvailable] = useState(true);
  const aiRef = useRef(false);
  aiRef.current = aiInpaint;
  const aiAvailableRef = useRef(true);
  aiAvailableRef.current = aiAvailable;

  useEffect(() => {
    apiFetch('/api/settings').then((r) => r.json()).then((s) => { setOutputDir(s.output_dir || ''); setAiInpaint(s.ai_inpaint === '1'); }).catch(() => {});
    getAiStatus().then((s) => { setAiStatus(s); setAiAvailable(!!s.available); }).catch(() => {});
  }, []);

  const updateJob = useCallback((id, patch) => {
    setJobs((prev) => prev.map((j) => (j.id === id ? { ...j, ...patch } : j)));
  }, []);

  const addFiles = useCallback((fileList) => {
    const incoming = Array.from(fileList || []);
    if (!incoming.length) return;
    let imgs = jobsRef.current.filter((j) => j.kind === 'image').length;
    let vids = jobsRef.current.filter((j) => j.kind === 'video').length;
    const accepted = [];
    let rejected = 0;
    for (const file of incoming) {
      const kind = classifyMediaFile(file);
      if (!kind) { rejected++; continue; }
      if (kind === 'image' && imgs >= MAX_IMAGES) { rejected++; continue; }
      if (kind === 'video' && vids >= MAX_VIDEOS) { rejected++; continue; }
      if (kind === 'image') imgs++; else vids++;
      accepted.push({ id: uid(), file, name: file.name, kind, status: 'pending', progress: 0, info: '', savedPath: '' });
    }
    if (accepted.length) setJobs((prev) => [...prev, ...accepted]);
    setToast(rejected ? `${rejected} file bị bỏ qua (sai định dạng hoặc vượt giới hạn)` : `${accepted.length} file đã thêm`);
  }, []);

  const onDrop = useCallback((e) => {
    e.preventDefault();
    setDragOver(false);
    if (!processing) addFiles(e.dataTransfer?.files);
  }, [addFiles, processing]);

  // Process a single job (used by both "process all" and per-row retry).
  const processOneJob = useCallback(async (j) => {
    try {
      updateJob(j.id, { status: 'processing', progress: j.kind === 'video' ? 0.02 : 0.1, info: '', savedPath: '' });
      if (j.kind === 'video' && aiRef.current && aiAvailableRef.current) {
        const controller = new AbortController();
        abortRef.current = controller;
        const aout = await processVideoAI(j.file, (p, info) => updateJob(j.id, { progress: p, info }), controller.signal);
        abortRef.current = null;
        updateJob(j.id, { status: 'done', progress: 1, savedPath: aout.path, info: 'Đã gỡ watermark (AI)' });
        return;
      }
      let out;
      if (j.kind === 'video') {
        const controller = new AbortController();
        abortRef.current = controller;
        out = await processVideo(j.file, (p, info) => updateJob(j.id, { progress: p, info }), controller.signal);
        abortRef.current = null;
      } else {
        updateJob(j.id, { progress: 0.45 });
        out = await processImage(j.file);
        updateJob(j.id, { progress: 0.8 });
      }
      const saved = await saveToDisk(out.blob, out.name, out.kind);
      updateJob(j.id, {
        status: 'done', progress: 1, savedPath: saved.path,
        info: out.warning || (out.applied ? 'Đã gỡ watermark' : 'Không thấy watermark'),
      });
    } catch (e) {
      const msg = e?.message || 'Thất bại';
      const cancelled = cancelRef.current || /cancel/i.test(msg);
      updateJob(j.id, { status: cancelled ? 'cancelled' : 'error', progress: 0, info: cancelled ? 'Đã huỷ' : msg });
    }
  }, [updateJob]);

  const runAll = useCallback(async () => {
    if (processing) return;
    cancelRef.current = false;
    setProcessing(true);
    const pending = jobsRef.current.filter((j) => j.status !== 'done');
    for (const j of pending) {
      if (cancelRef.current) { updateJob(j.id, { status: 'cancelled', progress: 0, info: 'Đã huỷ' }); continue; }
      await processOneJob(j);
      await new Promise((r) => setTimeout(r, 0));
    }
    setProcessing(false);
    abortRef.current = null;
    const done = jobsRef.current.filter((j) => j.status === 'done').length;
    setToast(cancelRef.current ? 'Đã dừng xử lý.' : `Hoàn tất — ${done} file đã lưu`);
    cancelRef.current = false;
  }, [processing, processOneJob, updateJob]);

  const retryJob = useCallback(async (j) => {
    if (processing) return;
    cancelRef.current = false;
    setProcessing(true);
    await processOneJob(j);
    setProcessing(false);
    abortRef.current = null;
    cancelRef.current = false;
  }, [processing, processOneJob]);

  const cancel = useCallback(() => {
    cancelRef.current = true;
    try { abortRef.current?.abort(); } catch (_) { /* ignore */ }
    setToast('Đang dừng…');
  }, []);

  const removeJob = useCallback((id) => {
    setJobs((prev) => prev.filter((j) => j.id !== id));
  }, []);

  const clearJobs = () => { if (!processing) { setJobs([]); setToast(''); } };
  const openOutput = () => apiFetch('/api/open-output', { method: 'POST' }).catch(() => {});
  const openFile = (job) => {
    if (!job.savedPath) return;
    const fd = new FormData();
    fd.append('path', job.savedPath);
    apiFetch('/api/open-path', { method: 'POST', body: fd }).catch(() => {});
  };

  const openSettings = () => { setDraftDir(outputDir); setSettingsOpen(true); getAiStatus().then((s) => { setAiStatus(s); setAiAvailable(!!s.available); }); };
  const saveSettings = async () => {
    const fd = new FormData();
    fd.append('output_dir', draftDir);
    fd.append('ai_inpaint', aiInpaint ? '1' : '0');
    try {
      const r = await apiFetch('/api/settings', { method: 'POST', body: fd });
      const s = await r.json();
      setOutputDir(s.output_dir || draftDir);
      setAiInpaint(s.ai_inpaint === '1');
    } catch (_) { /* ignore */ }
    setSettingsOpen(false);
  };

  const hasJobs = jobs.length > 0;
  const doneCount = jobs.filter((j) => j.status === 'done').length;
  const allDone = hasJobs && jobs.every((j) => j.status === 'done');

  return (
    <Box sx={{ minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>
      <AppBar position="static" elevation={0} sx={{ bgcolor: 'background.paper', borderBottom: '1px solid', borderColor: 'divider' }}>
        <Toolbar variant="dense">
          <AutoFixHighIcon sx={{ color: 'primary.main', mr: 1 }} />
          <Typography sx={{ fontWeight: 700, flex: 1 }}>Gemini Clean</Typography>
          <Tooltip title="Mở thư mục đầu ra">
            <IconButton onClick={openOutput} size="small"><FolderOpenIcon /></IconButton>
          </Tooltip>
          <Tooltip title="Cài đặt">
            <span><IconButton onClick={openSettings} size="small" disabled={processing}><SettingsIcon /></IconButton></span>
          </Tooltip>
        </Toolbar>
      </AppBar>

      <Container maxWidth="md" sx={{ py: 3, flex: 1 }}>
        <Paper
          variant="outlined"
          onDragOver={(e) => { e.preventDefault(); if (!processing) setDragOver(true); }}
          onDragLeave={() => setDragOver(false)}
          onDrop={onDrop}
          onClick={() => !processing && fileRef.current?.click()}
          sx={{
            p: hasJobs ? 2.5 : 6, mb: 2.5, textAlign: 'center', cursor: processing ? 'default' : 'pointer',
            borderStyle: 'dashed', borderWidth: 2,
            borderColor: dragOver ? 'primary.main' : 'divider',
            bgcolor: dragOver ? 'rgba(224,134,63,0.08)' : 'transparent',
            transition: 'all .15s ease',
          }}
        >
          <CloudUploadIcon sx={{ fontSize: hasJobs ? 30 : 44, color: 'primary.main', opacity: 0.9 }} />
          <Typography sx={{ fontWeight: 600, mt: 1 }}>
            {hasJobs ? 'Thêm / kéo-thả file' : 'Kéo-thả hoặc bấm để chọn ảnh / video'}
          </Typography>
          {!hasJobs && (
            <>
              <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
                PNG · JPEG · WebP · MP4 · MOV — tối đa {MAX_IMAGES} ảnh &amp; {MAX_VIDEOS} video
              </Typography>
              <Typography variant="caption" sx={{ color: 'success.main', display: 'block', mt: 1, fontWeight: 600 }}>
                ● 100% xử lý cục bộ — file không rời khỏi máy
              </Typography>
            </>
          )}
          <input
            ref={fileRef} type="file" hidden multiple
            accept="image/png,image/jpeg,image/webp,video/mp4,video/quicktime,.mp4,.mov,.m4v"
            onChange={(e) => { addFiles(e.target.files); e.target.value = ''; }}
          />
        </Paper>

        {hasJobs && (
          <Stack direction="row" spacing={1.25} sx={{ mb: 2, flexWrap: 'wrap', rowGap: 1, alignItems: 'center' }}>
            {!processing ? (
              <Button variant="contained" startIcon={<AutoFixHighIcon />} onClick={runAll} disabled={allDone}>
                Xử lý &amp; Lưu tất cả
              </Button>
            ) : (
              <Button variant="contained" color="error" startIcon={<StopIcon />} onClick={cancel}>
                Dừng
              </Button>
            )}
            <Button variant="outlined" onClick={() => fileRef.current?.click()} disabled={processing}>Thêm file</Button>
            <Button variant="outlined" color="inherit" onClick={clearJobs} disabled={processing}>Xoá danh sách</Button>
            <Tooltip title="Mở thư mục đầu ra">
              <Button variant="outlined" color="inherit" startIcon={<FolderOpenIcon />} onClick={openOutput}>Thư mục</Button>
            </Tooltip>
            <Box sx={{ flex: 1 }} />
            <Typography variant="body2" color="text.secondary">{doneCount}/{jobs.length} xong</Typography>
          </Stack>
        )}

        {jobs.map((job) => (
          <JobRow key={job.id} job={job} busy={processing} onRemove={removeJob} onOpen={openFile} onRetry={retryJob} />
        ))}

        {toast && (
          <Typography variant="body2" color="text.secondary" sx={{ mt: 2 }}>{toast}</Typography>
        )}
        {hasJobs && (
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1.5 }}>
            File sạch được lưu vào: <b>{outputDir || '…'}</b>
          </Typography>
        )}
      </Container>

      <Dialog open={settingsOpen} onClose={() => setSettingsOpen(false)} fullWidth maxWidth="sm">
        <DialogTitle>Cài đặt</DialogTitle>
        <DialogContent>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 1.5 }}>
            Thư mục lưu file đã gỡ watermark:
          </Typography>
          <TextField
            fullWidth size="small" value={draftDir}
            onChange={(e) => setDraftDir(e.target.value)}
            placeholder="C:\\Users\\…\\Downloads\\GeminiClean"
          />
          <Box sx={{ mt: 2 }}>
            <FormControlLabel
              control={<Switch checked={aiInpaint && aiAvailable} disabled={!aiAvailable} onChange={(e) => setAiInpaint(e.target.checked)} />}
              label="AI inpaint cho video (sạch nhất, chậm)"
            />
            <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
              {aiAvailable
                ? 'Tái tạo nền dưới watermark bằng LaMa (xử lý ở backend). Lần đầu tải model ~88MB; cần ffmpeg.'
                : 'Không khả dụng trong bản này — cần chạy bằng update.bat (onnxruntime + ffmpeg).'}
              {aiStatus && aiAvailable && (
                <>{' · '}{aiStatus.ffmpeg ? 'ffmpeg ✓' : 'ffmpeg ✗'}{' · '}
                {(aiStatus.providers || []).some((p) => /Dml|CUDA/.test(p)) ? 'GPU ✓' : 'CPU (chậm)'}{' · '}
                {aiStatus.model_ready ? 'model ✓' : 'model sẽ tải'}</>
              )}
            </Typography>
          </Box>
          <Divider sx={{ my: 2 }} />
          <Typography variant="caption" color="text.secondary">
            Watermark engine: gemini-watermark-remover (MIT). Chỉ gỡ watermark hiển thị; dấu vô hình (SynthID) vẫn còn.
          </Typography>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setSettingsOpen(false)} color="inherit">Huỷ</Button>
          <Button onClick={saveSettings} variant="contained">Lưu</Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}
