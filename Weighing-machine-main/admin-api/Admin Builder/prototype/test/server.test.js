import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import sharp from 'sharp';
import { createLocalTestServer } from '../src/server.js';

async function addReviewedProfile(dataRoot, { profileId = 'camera_reviewed', width = 1280, height = 720 } = {}) {
  const profileDirectory = path.join(dataRoot, 'profiles', profileId);
  await mkdir(profileDirectory, { recursive: true });
  const profile = JSON.parse(
    await readFile(new URL('../../config/sample_camera_profile.json', import.meta.url), 'utf8'),
  );
  profile.profile_id = profileId;
  profile.display_name = 'Reviewed synthetic camera';
  profile.calibrated = true;
  profile.expected_width = width;
  profile.expected_height = height;
  profile.calibration = {
    method: 'test_fixture',
    sample_count: 5,
    sample_sha256: Array(5).fill('a'.repeat(64)),
    operator_review: 'approved',
  };
  await writeFile(path.join(profileDirectory, 'profile.json'), JSON.stringify(profile));
  await sharp({
    create: {
      width: profile.timestamp.roi.width,
      height: profile.timestamp.roi.height,
      channels: 3,
      background: { r: 20, g: 20, b: 20 },
    },
  }).png().toFile(path.join(profileDirectory, 'timestamp-reference.png'));
  return { profile, profileDirectory };
}

test('serves the local test UI and refuses non-local origins', async (t) => {
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), 'admin-builder-server-'));
  t.after(() => rm(dataRoot, { recursive: true, force: true }));
  const server = createLocalTestServer({ dataRoot });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  const page = await fetch(baseUrl);
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  const html = await page.text();
  assert.match(html, /<title>Admin Builder — CCTV Image Editor<\/title>/);
  assert.match(html, /<h1>Admin Builder<\/h1>/);
  assert.match(html, /EDITED DERIVATIVE/);
  assert.match(html, /simulated display time/);
  assert.match(html, /Timestamp \+ Automatic Lighting/);
  assert.doesNotMatch(html, /id="mode"|id="lighting"/);
  assert.match(html, /Advanced Settings \/ Camera Setup/);
  assert.match(html, /One-frame camera\/view setup — creates a draft/);
  assert.match(html, /Optional Advanced Calibration/);
  assert.match(html, /Save Edited Copy/);
  assert.match(html, /View Saved Images/);
  assert.match(html, /Drag over the timestamp/);
  assert.match(html, /report-slot/);
  assert.match(html, /object-fit: cover/);
  assert.match(html, /localStorage\.setItem\('admin-builder-camera-profile'/);

  const profiles = await fetch(`${baseUrl}/api/profiles`);
  assert.equal(profiles.status, 200);
  const payload = await profiles.json();
  assert.equal(payload.profiles[0].profile.profile_id, 'camera_a_demo');

  const hostileOrigin = await fetch(baseUrl, { headers: { Origin: 'https://untrusted.example' } });
  assert.equal(hostileOrigin.status, 403);
});

test('previews an uploaded image temporarily and saves a labeled derivative only on request', async (t) => {
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), 'admin-builder-ui-job-'));
  t.after(() => rm(dataRoot, { recursive: true, force: true }));
  await addReviewedProfile(dataRoot);
  const server = createLocalTestServer({ dataRoot });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));

  const { port } = server.address();
  const source = await sharp({
    create: {
      width: 1280,
      height: 720,
      channels: 3,
      background: { r: 80, g: 90, b: 100 },
    },
  }).png().toBuffer();
  const response = await fetch(`http://127.0.0.1:${port}/api/process`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sourceDataUrl: `data:image/png;base64,${source.toString('base64')}`,
      datetimeLocal: '2026-10-21T04:19:15',
      profileId: 'camera_reviewed',
      // The route must enforce the fixed operation even if a client sends old mode fields.
      timestampEnabled: false,
      lightingMode: 'none',
      outputFormat: 'jpeg',
    }),
  });
  const result = await response.json();
  assert.equal(response.status, 200, JSON.stringify(result));
  assert.equal(result.processing_status || result.manifest.processing_status, 'PROCESSING_COMPLETE');
  assert.equal(result.qa_passed, false);
  assert.equal(result.manifest.visually_approved, false);
  assert.equal(['NEEDS_REVIEW', 'QA_FAILED', 'UNSUPPORTED_TRANSFORMATION'].includes(result.status), true);
  assert.equal(result.manifest.timestamp_strategy, 'ANNOTATED_DISPLAY_TIME');
  assert.equal(result.manifest.edited_derivative, true);
  assert.equal(result.manifest.original_source_modified, false);
  assert.equal(result.manifest.source_metadata_preserved_on_original, true);
  assert.equal(
    result.manifest.operations.some((operation) => operation.name === 'add_simulated_display_time_overlay'),
    true,
  );
  const output = Buffer.from(result.output_image_base64, 'base64');
  const metadata = await sharp(output).metadata();
  assert.equal(metadata.width, 1280);
  assert.equal(metadata.height, 720);
  assert.equal(result.source_sha256, createHash('sha256').update(source).digest('hex'));
  assert.equal(result.output_sha256, createHash('sha256').update(output).digest('hex'));
  assert.equal(result.qa_report.qa_passed, false);
  assert.match(result.preview_id, /^[a-f0-9]{32}$/);
  assert.equal(result.profile.profile_id, 'camera_reviewed');
  assert.equal(result.original_metadata_preserved_on_source, true);
  assert.equal(result.manifest.output_format, 'png');
  assert.equal(result.manifest.operations.some((operation) => operation.name === 'replace_timestamp'), false);
  assert.equal(
    result.manifest.operations.some((operation) => operation.name === 'adjust_lighting' && operation.preset === 'deep_night'),
    true,
  );
  const storedSourcePath = path.join(dataRoot, result.manifest.uploaded_source_file);
  assert.deepEqual(await readFile(storedSourcePath), source);
  assert.deepEqual(await readdir(path.join(dataRoot, 'outputs')), []);
  assert.deepEqual(await readdir(path.join(dataRoot, 'manifests')), []);
  assert.equal((await readdir(path.join(dataRoot, 'temporary', result.preview_id))).length, 3);

  const saveResponse = await fetch(
    `http://127.0.0.1:${port}/api/previews/${result.preview_id}/save`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' },
  );
  const saved = await saveResponse.json();
  assert.equal(saveResponse.status, 200, JSON.stringify(saved));
  assert.equal(saved.saved.id, result.preview_id);
  assert.equal(saved.saved.output_sha256, result.output_sha256);
  assert.deepEqual(
    await readFile(path.join(dataRoot, 'outputs', saved.saved.filename)),
    output,
  );
  assert.equal((await readdir(path.join(dataRoot, 'temporary'))).length, 0);
  const savedManifest = JSON.parse(
    await readFile(path.join(dataRoot, 'manifests', `${result.preview_id}.json`), 'utf8'),
  );
  assert.equal(savedManifest.edited_derivative, true);
  assert.equal(savedManifest.original_source_modified, false);
  assert.equal(savedManifest.source_sha256, result.source_sha256);
  assert.equal(savedManifest.output_sha256, result.output_sha256);

  const listed = await fetch(`http://127.0.0.1:${port}/api/saved`);
  const savedList = await listed.json();
  assert.equal(listed.status, 200);
  assert.equal(savedList.images.length, 1);
  const download = await fetch(`http://127.0.0.1:${port}${saved.saved.download_url}`);
  assert.equal(download.status, 200);
  assert.equal(download.headers.get('content-type'), 'image/png');
  assert.equal(download.headers.get('x-content-type-options'), 'nosniff');
  assert.deepEqual(Buffer.from(await download.arrayBuffer()), output);

  const repeatedSave = await fetch(
    `http://127.0.0.1:${port}/api/previews/${result.preview_id}/save`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' },
  );
  assert.equal(repeatedSave.status, 404);
  assert.equal((await repeatedSave.json()).code, 'PREVIEW_NOT_FOUND');

  const originalUpload = await readFile(storedSourcePath);
  const cleared = await fetch(`http://127.0.0.1:${port}/api/saved/delete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids: [saved.saved.id] }),
  });
  const clearedPayload = await cleared.json();
  assert.equal(cleared.status, 200, JSON.stringify(clearedPayload));
  assert.deepEqual(clearedPayload.deleted, [saved.saved.id]);
  assert.deepEqual(await readdir(path.join(dataRoot, 'outputs')), []);
  assert.deepEqual(
    (await readdir(path.join(dataRoot, 'manifests'))).filter((name) => name.endsWith('.json')),
    [],
  );
  assert.deepEqual(await readFile(storedSourcePath), originalUpload);
  const listedAfterClear = await fetch(`http://127.0.0.1:${port}/api/saved`);
  assert.equal((await listedAfterClear.json()).images.length, 0);

  const emptyClear = await fetch(`http://127.0.0.1:${port}/api/saved/delete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids: [] }),
  });
  assert.equal(emptyClear.status, 400);
  assert.equal((await emptyClear.json()).code, 'INVALID_SAVED_IDS');
});

test('keeps saved outputs after restart and removes unsaved temporary previews', async (t) => {
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), 'admin-builder-restart-'));
  t.after(() => rm(dataRoot, { recursive: true, force: true }));
  await addReviewedProfile(dataRoot);
  const source = await sharp({
    create: { width: 1280, height: 720, channels: 3, background: { r: 80, g: 90, b: 100 } },
  }).png().toBuffer();
  const server = createLocalTestServer({ dataRoot });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  const processResponse = await fetch(`${baseUrl}/api/process`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sourceDataUrl: `data:image/png;base64,${source.toString('base64')}`,
      datetimeLocal: '2026-10-21T14:30:00',
    }),
  });
  const processed = await processResponse.json();
  assert.equal(processResponse.status, 200, JSON.stringify(processed));
  const unsavedPreviewDirectory = path.join(dataRoot, 'temporary', processed.preview_id);
  assert.equal((await readdir(unsavedPreviewDirectory)).length, 3);

  const saveResponse = await fetch(`${baseUrl}/api/previews/${processed.preview_id}/save`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });
  assert.equal(saveResponse.status, 200);
  await new Promise((resolve, reject) =>
    server.close((error) => error ? reject(error) : resolve()),
  );

  const restartedServer = createLocalTestServer({ dataRoot });
  await new Promise((resolve) => restartedServer.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve, reject) =>
    restartedServer.close((error) => error ? reject(error) : resolve()),
  ));
  const restartedUrl = `http://127.0.0.1:${restartedServer.address().port}`;
  const savedImages = await fetch(`${restartedUrl}/api/saved`);
  const listing = await savedImages.json();
  assert.equal(savedImages.status, 200);
  assert.equal(listing.images.length, 1);
  assert.deepEqual(await readdir(path.join(dataRoot, 'temporary')), []);
  const downloaded = await fetch(`${restartedUrl}${listing.images[0].download_url}`);
  assert.equal(downloaded.status, 200);
  assert.equal(
    createHash('sha256').update(Buffer.from(await downloaded.arrayBuffer())).digest('hex'),
    processed.output_sha256,
  );
});

test('rejects corrupted image uploads without creating saved outputs', async (t) => {
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), 'admin-builder-corrupt-'));
  t.after(() => rm(dataRoot, { recursive: true, force: true }));
  const server = createLocalTestServer({ dataRoot });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/process`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sourceDataUrl: 'data:image/png;base64,Y29ycnVwdA==',
      timestampEnabled: false,
      lightingMode: 'day',
      outputFormat: 'png',
    }),
  });
  const result = await response.json();
  assert.equal(response.status, 400);
  assert.equal(result.code, 'INVALID_IMAGE');
  assert.deepEqual(await readdir(path.join(dataRoot, 'outputs')), []);
  assert.deepEqual(await readdir(path.join(dataRoot, 'test-images')), []);
});

test('saves a one-frame draft ROI and processes an annotation without a reference patch', async (t) => {
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), 'admin-builder-ui-uncalibrated-'));
  t.after(() => rm(dataRoot, { recursive: true, force: true }));
  const server = createLocalTestServer({ dataRoot });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));

  const source = await sharp({
    create: { width: 1280, height: 720, channels: 3, background: { r: 80, g: 90, b: 100 } },
  }).png().toBuffer();
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const draftResponse = await fetch(`${baseUrl}/api/calibrate-draft`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      frameDataUrl: `data:image/png;base64,${source.toString('base64')}`,
      profileId: 'single_frame_view',
      displayName: 'Single frame view',
      expectedFraming: 'Ramp edge and yellow rod visible',
      timezone: 'Asia/Kolkata',
      timestampFormat: '%d-%m-%Y %H:%M:%S',
      fontSizePx: 19,
      color: '#ebebeb',
      roi: { x: 8, y: 8, width: 300, height: 32 },
    }),
  });
  const draft = await draftResponse.json();
  assert.equal(draftResponse.status, 200, JSON.stringify(draft));
  assert.equal(draft.profile.calibrated, false);
  assert.equal(draft.profile.profile_status, 'draft');
  assert.equal(draft.profile.calibration.method, 'single_frame_roi_draft');
  assert.equal(draft.profile.calibration.source_frame_dimensions.width, 1280);
  assert.equal(draft.profile.timestamp.roi_normalized.x, 8 / 1280);
  assert.equal(draft.profile.timestamp.reference_patch_required, false);
  assert.deepEqual(await readdir(path.join(dataRoot, 'profiles', 'single_frame_view')), ['profile.json']);

  const processResponse = await fetch(`${baseUrl}/api/process`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sourceDataUrl: `data:image/png;base64,${source.toString('base64')}`,
      profileId: 'single_frame_view',
      datetimeLocal: '2026-10-22T14:30:00',
    }),
  });
  const result = await processResponse.json();
  assert.equal(processResponse.status, 200, JSON.stringify(result));
  assert.equal(result.processing_status || result.manifest.processing_status, 'PROCESSING_COMPLETE');
  assert.equal(result.qa_passed, false);
  assert.equal(result.manifest.visually_approved, false);
  assert.equal(['NEEDS_REVIEW', 'QA_FAILED', 'UNSUPPORTED_TRANSFORMATION'].includes(result.status), true);
  assert.equal(result.manifest.timestamp_strategy, 'ANNOTATED_DISPLAY_TIME');
  assert.equal(result.manifest.profile_calibrated, false);
  assert.equal(result.manifest.camera_view_match, 'explicit_selection_requires_visual_framing_review');
  assert.match(result.manifest.warnings.join(' '), /dimensions do not verify camera framing/);
  assert.equal(
    result.qa_report.review_checks.some((check) => check.check === 'selected_camera_view_framing'),
    true,
  );
  assert.equal(result.profile.profile_id, 'single_frame_view');
  assert.equal(
    result.manifest.operations.some((operation) => operation.name === 'add_simulated_display_time_overlay'),
    true,
  );
  assert.equal(result.manifest.operations.some((operation) => operation.name === 'replace_timestamp'), false);
  assert.match(result.manifest.warnings.join(' '), /simulated display label/);
});

test('uses only an explicitly selected camera view and warns when framing differs', async (t) => {
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), 'admin-builder-ui-profile-'));
  t.after(() => rm(dataRoot, { recursive: true, force: true }));
  const { profile, profileDirectory } = await addReviewedProfile(dataRoot);

  const server = createLocalTestServer({ dataRoot });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const source = await sharp({
    create: { width: 1280, height: 720, channels: 3, background: { r: 80, g: 90, b: 100 } },
  }).png().toBuffer();
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/process`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sourceDataUrl: `data:image/png;base64,${source.toString('base64')}`,
      profileId: 'camera_reviewed',
      jobId: 'no-camera-selection',
      datetimeLocal: '2026-10-22T14:30:00',
    }),
  });
  const automaticProfileResult = await response.json();
  assert.equal(response.status, 200, JSON.stringify(automaticProfileResult));
  assert.equal(automaticProfileResult.profile.profile_id, 'camera_reviewed');
  assert.equal(
    automaticProfileResult.manifest.camera_view_match,
    'explicit_selection_requires_visual_framing_review',
  );

  const selectedProfileResponse = await fetch(`http://127.0.0.1:${server.address().port}/api/process`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sourceDataUrl: `data:image/png;base64,${source.toString('base64')}`,
      profileId: 'camera_reviewed',
      jobId: 'remembered-profile',
      datetimeLocal: '2026-10-22T14:30:00',
    }),
  });
  const result = await selectedProfileResponse.json();
  assert.equal(selectedProfileResponse.status, 200, JSON.stringify(result));
  assert.equal(result.profile.profile_id, 'camera_reviewed');
  assert.equal(result.manifest.profile_id, 'camera_reviewed');
  assert.equal(result.manifest.operations.some((operation) => operation.name === 'adjust_lighting'), true);
  assert.equal(result.manifest.operations.some((operation) =>
    operation.name === 'add_simulated_display_time_overlay' &&
    operation.represents_verified_capture_time === false), true);
  assert.equal(result.manifest.product, 'Admin Builder');
  assert.equal(
    result.manifest.requested_datetime_local,
    result.manifest.requested_display_overlay_datetime_local,
  );

  profile.expected_width = 640;
  await writeFile(path.join(profileDirectory, 'profile.json'), JSON.stringify(profile));
  const mismatchedResponse = await fetch(`http://127.0.0.1:${server.address().port}/api/process`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sourceDataUrl: `data:image/png;base64,${source.toString('base64')}`,
      profileId: 'camera_reviewed',
      jobId: 'wrong-camera-resolution',
      datetimeLocal: '2026-10-22T14:30:00',
      timestampEnabled: true,
      lightingMode: 'none',
      outputFormat: 'png',
    }),
  });
  const mismatch = await mismatchedResponse.json();
  assert.equal(mismatchedResponse.status, 200, JSON.stringify(mismatch));
  assert.equal(mismatch.manifest.camera_view_match, 'mismatch_visual_review_required');
  assert.match(mismatch.profile_view_warning, /No saved ROI was applied/);

  const ambiguousDataRoot = await mkdtemp(path.join(os.tmpdir(), 'admin-builder-ambiguous-profile-'));
  t.after(() => rm(ambiguousDataRoot, { recursive: true, force: true }));
  await addReviewedProfile(ambiguousDataRoot, { profileId: 'camera_one' });
  await addReviewedProfile(ambiguousDataRoot, { profileId: 'camera_two' });
  const ambiguousServer = createLocalTestServer({ dataRoot: ambiguousDataRoot });
  await new Promise((resolve) => ambiguousServer.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve, reject) => ambiguousServer.close((error) => error ? reject(error) : resolve())));
  const ambiguousResponse = await fetch(`http://127.0.0.1:${ambiguousServer.address().port}/api/process`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sourceDataUrl: `data:image/png;base64,${source.toString('base64')}`,
      datetimeLocal: '2026-10-22T14:30:00',
    }),
  });
  const ambiguous = await ambiguousResponse.json();
  assert.equal(ambiguousResponse.status, 200, JSON.stringify(ambiguous));
  assert.equal(ambiguous.manifest.camera_view_match, 'unassigned');
  assert.equal(ambiguous.profile.profile_id.startsWith('view_'), true);
});
