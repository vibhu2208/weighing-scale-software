import React, { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api/client.js';
import { REPORT_PHOTO_SLOT, reportSlotCoverCrop } from '../lib/reportSlot.js';

const CAMERA_TIMEZONE = 'Asia/Kolkata';
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

function kolkataDateTimeLocal() {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: CAMERA_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date());
  const value = (type) => parts.find((part) => part.type === type)?.value;
  return `${value('year')}-${value('month')}-${value('day')}T${value('hour')}:${value('minute')}:${value('second')}`;
}

function splitDateTime(value) {
  const [date = '', time = ''] = String(value || '').split('T');
  return { date, time };
}

function joinDateTime(date, time) {
  if (!date) return '';
  const clock = time ? (time.length === 5 ? `${time}:00` : time) : '00:00:00';
  return `${date}T${clock}`;
}

function normalizeDateTimeLocal(value) {
  if (!value) return '';
  return value.length === 16 ? `${value}:00` : value;
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(new Error('Could not read the selected image.'));
    reader.readAsDataURL(file);
  });
}

function bytesFromBase64(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function failedChecks(result) {
  return (result?.qa_report?.hard_checks || []).filter((item) => item.pass === false);
}

function qaTone(qaStatus) {
  if (qaStatus === 'QA_FAILED' || qaStatus === 'UNSUPPORTED_TRANSFORMATION') return 'error';
  if (qaStatus === 'APPROVED') return 'success';
  return 'info';
}

function describeProcessResult(processed) {
  const qaStatus = processed.qa_status || processed.manifest?.qa_status || 'NEEDS_REVIEW';
  const failed = failedChecks(processed);
  const lighting = processed.operations?.find((operation) => operation.name === 'adjust_lighting');
  const parts = [
    'Processing completed on a copy. The original CCTV file is unchanged.',
    `QA status: ${qaStatus}. This derivative is not approved to replace a report image.`,
  ];
  if (failed.length) {
    parts.push(`Failed checks: ${failed.map((item) => item.check).join(', ')}.`);
  }
  if (lighting) {
    const ev = lighting.parameters?.applied_exposure_ev;
    parts.push(
      `Lighting classified as ${lighting.preset.replaceAll('_', ' ')}` +
        (Number.isFinite(ev) ? ` at ${ev} EV` : '') +
        '. This is a simulation, not a recorded camera condition.',
    );
  }
  parts.push('The camera timestamp is unchanged. The added label is a requested simulation time.');
  return { message: parts.join(' '), tone: qaTone(qaStatus), qaStatus };
}

function testDownloadName(result) {
  const qaStatus = result.qa_status || result.manifest?.qa_status || 'NEEDS_REVIEW';
  const base = result.saved?.filename || result.output_image_path || 'EDITED_derivative.png';
  if (qaStatus === 'APPROVED') return base;
  return `TEST_${qaStatus}_${base}`;
}

export default function AdminBuilder() {
  const [sourceFile, setSourceFile] = useState(null);
  const [sourceDataUrl, setSourceDataUrl] = useState('');
  const [datetimeLocal, setDatetimeLocal] = useState(kolkataDateTimeLocal);
  const [status, setStatus] = useState('Upload a CCTV frame to begin.');
  const [statusTone, setStatusTone] = useState('muted');
  const [processing, setProcessing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState(null);
  const [outputUrl, setOutputUrl] = useState('');
  const [savedImages, setSavedImages] = useState([]);
  const [savedStatus, setSavedStatus] = useState('');
  const [savedPreviews, setSavedPreviews] = useState({});
  const [selectedIds, setSelectedIds] = useState([]);
  const [clearing, setClearing] = useState(false);
  const objectUrls = useRef([]);
  const allSelected = savedImages.length > 0 && selectedIds.length === savedImages.length;
  const someSelected = selectedIds.length > 0 && !allSelected;
  const { date, time } = splitDateTime(datetimeLocal);

  const overlay = useMemo(
    () => result?.operations?.find((operation) => operation.name === 'add_simulated_display_time_overlay'),
    [result],
  );
  const lighting = useMemo(
    () => result?.operations?.find((operation) => operation.name === 'adjust_lighting'),
    [result],
  );
  const scene = result?.manifest?.scene_dimensions;
  const slotCrop = reportSlotCoverCrop(scene?.width, scene?.height);

  function rememberUrl(url) {
    objectUrls.current.push(url);
    return url;
  }

  useEffect(() => () => {
    objectUrls.current.forEach((url) => URL.revokeObjectURL(url));
  }, []);

  function setMessage(message, tone = 'muted') {
    setStatus(message);
    setStatusTone(tone);
  }

  async function onSelectFile(event) {
    const file = event.target.files?.[0];
    if (!file) return;
    if (file.size > MAX_UPLOAD_BYTES) {
      setMessage('Image must be no larger than 25 MB.', 'error');
      event.target.value = '';
      return;
    }
    if (!/^image\/(jpeg|png)$/.test(file.type) && !/\.(jpe?g|png)$/i.test(file.name)) {
      setMessage('Upload a JPEG or PNG CCTV frame.', 'error');
      event.target.value = '';
      return;
    }
    try {
      const dataUrl = await fileToDataUrl(file);
      setSourceFile(file);
      setSourceDataUrl(dataUrl);
      setResult(null);
      setOutputUrl('');
      setMessage('Image uploaded. Original remains unchanged. Set the requested time, then process.', 'info');
    } catch (error) {
      setMessage(error.message, 'error');
    }
  }

  async function onProcess() {
    if (!sourceDataUrl) {
      setMessage('Upload a CCTV image first.', 'error');
      return;
    }
    const requestedTime = normalizeDateTimeLocal(datetimeLocal);
    if (!requestedTime) {
      setMessage('Enter the requested date and time.', 'error');
      return;
    }
    setProcessing(true);
    setResult(null);
    setMessage('Processing…', 'info');
    try {
      const processed = await api.processAdminBuilder({
        sourceDataUrl,
        datetimeLocal: requestedTime,
        timezone: CAMERA_TIMEZONE,
      });
      if (!processed.output_image_base64) {
        throw new Error('Processor did not return an image.');
      }
      if (processed.source_sha256 === processed.output_sha256) {
        throw new Error('Processor returned an unchanged image.');
      }
      const bytes = bytesFromBase64(processed.output_image_base64);
      const url = rememberUrl(URL.createObjectURL(new Blob([bytes], { type: 'image/png' })));
      setOutputUrl(url);
      setResult(processed);
      const summary = describeProcessResult(processed);
      setMessage(summary.message, summary.tone);
    } catch (error) {
      setResult(null);
      setOutputUrl('');
      setMessage(error.message || 'Processing failed.', 'error');
    } finally {
      setProcessing(false);
    }
  }

  async function onSave() {
    if (!result?.preview_id) {
      setMessage('Process an image before saving it.', 'error');
      return;
    }
    setSaving(true);
    try {
      const saved = await api.saveAdminBuilderPreview(result.preview_id);
      setResult((current) => (current ? { ...current, saved: saved.saved } : current));
      const qaStatus = result.qa_status || result.manifest?.qa_status || 'NEEDS_REVIEW';
      setMessage(
        `Saved unapproved test copy ${saved.saved.filename}. QA status remains ${qaStatus}. The original upload was not changed.`,
        qaTone(qaStatus),
      );
      await loadSavedImages();
    } catch (error) {
      setMessage(error.message || 'Save failed.', 'error');
    } finally {
      setSaving(false);
    }
  }

  async function onDownload() {
    if (!outputUrl || !result) {
      setMessage('Process an image before downloading it.', 'error');
      return;
    }
    const filename = testDownloadName(result);
    if (result.saved?.id) {
      await api.downloadAdminBuilderImage(result.saved.id, filename);
      setMessage(`Downloaded labeled test file ${filename}. It is not an approved report replacement.`, qaTone(result.qa_status));
      return;
    }
    const link = document.createElement('a');
    link.href = outputUrl;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setMessage(`Downloaded labeled test file ${filename}. It is not an approved report replacement.`, qaTone(result.qa_status));
  }

  async function loadSavedImages() {
    setSavedStatus('Loading saved edited images…');
    try {
      const listing = await api.listAdminBuilderSaved();
      const images = listing.images || [];
      setSavedImages(images);
      setSelectedIds((current) => current.filter((id) => images.some((image) => image.id === id)));
      const previews = {};
      await Promise.all(
        images.slice(0, 8).map(async (image) => {
          const blob = await api.fetchAdminBuilderImage(image.id);
          previews[image.id] = rememberUrl(URL.createObjectURL(blob));
        }),
      );
      setSavedPreviews(previews);
      setSavedStatus(
        images.length
          ? `${images.length} saved edited image${images.length === 1 ? '' : 's'}.`
          : 'No edited copies have been saved yet.',
      );
      return listing;
    } catch (error) {
      setSavedStatus(error.message || 'Could not load saved images.');
      return null;
    }
  }

  useEffect(() => {
    loadSavedImages();
  }, []);

  function toggleSelected(id, checked) {
    setSelectedIds((current) => {
      if (checked) return current.includes(id) ? current : [...current, id];
      return current.filter((item) => item !== id);
    });
  }

  function toggleSelectAll(checked) {
    setSelectedIds(checked ? savedImages.map((image) => image.id) : []);
  }

  async function onClearSelected() {
    if (!selectedIds.length) return;
    const count = selectedIds.length;
    const confirmed = window.confirm(
      `Clear ${count} selected edited image${count === 1 ? '' : 's'}? Original CCTV uploads are not deleted.`,
    );
    if (!confirmed) return;
    setClearing(true);
    try {
      const result = await api.deleteAdminBuilderSaved(selectedIds);
      const deleted = result.deleted || selectedIds;
      setSelectedIds([]);
      setSavedPreviews((current) => {
        const next = { ...current };
        deleted.forEach((id) => {
          delete next[id];
        });
        return next;
      });
      await loadSavedImages();
      setSavedStatus(
        deleted.length
          ? `Cleared ${deleted.length} edited image${deleted.length === 1 ? '' : 's'}.`
          : 'No matching saved images were found.',
      );
    } catch (error) {
      setSavedStatus(error.message || 'Could not clear saved images.');
    } finally {
      setClearing(false);
    }
  }

  const statusClass =
    statusTone === 'error'
      ? 'text-red-400'
      : statusTone === 'success'
        ? 'text-emerald-400'
        : 'text-slate-400';

  return (
    <div className="max-w-5xl space-y-6">
      <header>
        <h1 className="text-2xl font-semibold">Admin Builder</h1>
        <p className="mt-1 text-sm text-slate-400">
          Upload a CCTV frame and a requested local time. The copy keeps the camera timestamp, adds a labeled simulated time, and applies a time-dependent lighting grade. A generated image is not an approved replacement for original CCTV. Original files are never overwritten.
        </p>
      </header>

      <section className="card p-6 space-y-4">
        <label className="block text-sm font-medium">Upload CCTV image</label>
        <input
          type="file"
          accept="image/jpeg,image/png"
          onChange={onSelectFile}
          className="block w-full text-sm text-slate-300 file:mr-4 file:rounded-lg file:border-0 file:bg-brand-600 file:px-4 file:py-2 file:text-sm file:font-medium file:text-white"
        />
        <p className="text-xs text-slate-500">
          {sourceFile
            ? `${sourceFile.name} · JPG / PNG · original remains unchanged`
            : 'JPG / PNG · original remains unchanged'}
        </p>

        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block text-sm font-medium" htmlFor="admin-builder-date">
            Requested date
            <input
              id="admin-builder-date"
              type="date"
              className="field-input mt-1"
              value={date}
              onChange={(event) => setDatetimeLocal(joinDateTime(event.target.value, time))}
            />
          </label>
          <label className="block text-sm font-medium" htmlFor="admin-builder-time">
            Requested time
            <input
              id="admin-builder-time"
              type="time"
              step="1"
              className="field-input mt-1"
              value={time}
              onChange={(event) => setDatetimeLocal(joinDateTime(date, event.target.value))}
            />
          </label>
        </div>
        <p className="text-xs text-slate-500">
          Automatic lighting · Camera defaults · Report-compatible preview
        </p>

        <button
          type="button"
          className="btn-primary w-full"
          onClick={onProcess}
          disabled={processing}
        >
          {processing ? 'Processing…' : 'Process Image'}
        </button>
        <p className={`text-sm ${statusClass}`} role="status">{status}</p>
      </section>

      {result && outputUrl && (
        <section className="card p-6 space-y-4">
          <div className="grid gap-4 md:grid-cols-2">
            <figure>
              <figcaption className="mb-2 text-sm font-medium text-slate-300">Original</figcaption>
              <img src={sourceDataUrl} alt="Uploaded original CCTV image" className="w-full rounded-lg border border-slate-800 bg-slate-950" />
              <p className="mt-1 text-xs text-slate-500">Source preview</p>
            </figure>
            <figure>
              <figcaption className="mb-2 text-sm font-medium text-slate-300">Processed</figcaption>
              <img src={outputUrl} alt="Processed edited derivative" className="w-full rounded-lg border border-slate-800 bg-slate-950" />
              <p className="mt-1 text-xs text-slate-500">
                Unapproved test derivative
                {overlay ? ` · simulated ${overlay.requested_time || overlay.text}` : ''}
                {lighting ? ` · ${lighting.preset.replaceAll('_', ' ')} lighting` : ''}
              </p>
            </figure>
          </div>

          <div>
            <p className="mb-2 text-sm font-medium text-slate-300">Report slot preview</p>
            <div
              className="overflow-hidden rounded border border-slate-700 bg-slate-950"
              style={{ width: REPORT_PHOTO_SLOT.width, height: REPORT_PHOTO_SLOT.height }}
            >
              <img
                src={outputUrl}
                alt="Report cell crop of the processed derivative"
                className="h-full w-full object-cover"
              />
            </div>
            <p className="mt-1 text-xs text-slate-500">
              Simulated display time {overlay?.requested_time || overlay?.text || '—'}. This is not the camera capture time.
              {' '}{REPORT_PHOTO_SLOT.width} × {REPORT_PHOTO_SLOT.height} CSS px, object-fit cover. Read the time in this caption; the thumbnail is too small for the burned-in label.
            </p>
            {slotCrop.warning && (
              <p className="mt-1 text-xs text-amber-300">
                This report crop removes about {Math.round(slotCrop.croppedFraction * 100)}% from the{' '}
                {slotCrop.axis === 'horizontal' ? 'left/right' : 'top/bottom'}. Check that the truck and ramp remain visible.
              </p>
            )}
          </div>

          <div className="rounded-lg border border-slate-800 bg-slate-950/60 p-3 text-sm space-y-1">
            <p className="font-medium text-slate-200">
              Processing {result.processing_status || 'PROCESSING_COMPLETE'} · QA {result.qa_status || result.manifest?.qa_status || 'NEEDS_REVIEW'}
            </p>
            <p className="text-xs text-slate-400">
              HTTP success only means the job ran. Visual approval requires an explicit reviewer decision and is currently pending.
            </p>
            {failedChecks(result).length > 0 && (
              <p className="text-xs text-red-400">
                QA failed: {failedChecks(result).map((item) => item.check).join(', ')}.
              </p>
            )}
            {(result.warnings || result.manifest?.warnings || []).slice(0, 4).map((warning) => (
              <p key={warning} className="text-xs text-slate-500">{warning}</p>
            ))}
          </div>

          <div className="flex flex-wrap gap-3">
            <button type="button" className="btn-primary" onClick={onSave} disabled={saving || Boolean(result.saved)}>
              {result.saved ? 'Saved test copy' : saving ? 'Saving…' : 'Save unapproved test copy'}
            </button>
            <button type="button" className="btn-ghost" onClick={onDownload}>
              Download test derivative
            </button>
            <button type="button" className="btn-ghost" onClick={loadSavedImages}>
              Saved Images
            </button>
          </div>
        </section>
      )}

      {(savedImages.length > 0 || savedStatus) && (
        <section className="card p-6 space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="text-lg font-semibold">Saved images</h2>
            {savedImages.length > 0 && (
              <div className="flex flex-wrap items-center gap-3">
                <label className="flex items-center gap-2 text-sm text-slate-300">
                  <input
                    type="checkbox"
                    checked={allSelected}
                    ref={(element) => {
                      if (element) element.indeterminate = someSelected;
                    }}
                    onChange={(event) => toggleSelectAll(event.target.checked)}
                    aria-label="Select all saved images"
                  />
                  Select all
                </label>
                <button
                  type="button"
                  className="btn-danger text-xs disabled:opacity-40 disabled:pointer-events-none"
                  disabled={!selectedIds.length || clearing}
                  onClick={onClearSelected}
                >
                  {clearing
                    ? 'Clearing…'
                    : selectedIds.length
                      ? `Clear selected (${selectedIds.length})`
                      : 'Clear selected'}
                </button>
              </div>
            )}
          </div>
          <p className="text-sm text-slate-400">{savedStatus}</p>
          <div className="grid gap-4 md:grid-cols-2">
            {savedImages.map((image) => (
              <article key={image.id} className="rounded-lg border border-slate-800 p-4">
                <label className="flex items-start gap-2 min-w-0">
                  <input
                    type="checkbox"
                    className="mt-1 shrink-0"
                    checked={selectedIds.includes(image.id)}
                    onChange={(event) => toggleSelected(image.id, event.target.checked)}
                    aria-label={`Select ${image.filename}`}
                  />
                  <span className="text-sm font-medium break-all">{image.filename}</span>
                </label>
                <p className="mt-1 text-xs text-slate-500">
                  QA {image.qa_status || 'NEEDS_REVIEW'}
                  {image.visually_approved ? '' : ' · unapproved test copy'}
                </p>
                {savedPreviews[image.id] && (
                  <img src={savedPreviews[image.id]} alt="" className="mt-3 w-full rounded border border-slate-800" />
                )}
                <button
                  type="button"
                  className="btn-primary mt-3"
                  onClick={() => api.downloadAdminBuilderImage(
                    image.id,
                    image.visually_approved ? image.filename : `TEST_${image.qa_status || 'NEEDS_REVIEW'}_${image.filename}`,
                  )}
                >
                  Download test copy
                </button>
              </article>
            ))}
          </div>
        </section>
      )}

      {result && (
        <details className="text-xs text-slate-500">
          <summary className="cursor-pointer">Developer provenance</summary>
          <div className="mt-2 space-y-1 rounded-lg border border-slate-800 bg-slate-950/60 p-3">
            <p>Source SHA-256: {result.source_sha256}</p>
            <p>Output SHA-256: {result.output_sha256}</p>
            <p>Camera timezone: {result.manifest?.camera_timezone || CAMERA_TIMEZONE}</p>
            <p>Processing: {result.processing_status || result.manifest?.processing_status || 'PROCESSING_COMPLETE'}</p>
            <p>QA status: {result.qa_status || result.manifest?.qa_status || 'NEEDS_REVIEW'}</p>
            {lighting?.parameters?.applied_exposure_ev != null && (
              <p>
                Lighting EV {lighting.parameters.applied_exposure_ev}
                {lighting.parameters.output_mean_luminance != null ? ` · output mean ${lighting.parameters.output_mean_luminance}` : ''}
                {lighting.parameters.highlight_limited ? ' · highlight-limited' : ''}
              </p>
            )}
            <p>
              Camera profiles and ROI calibration stay in the processor. Routine jobs do not require them and do not recover pixels hidden under the original OSD.
            </p>
          </div>
        </details>
      )}
    </div>
  );
}
