'use strict';

const path = require('path');
const { pathToFileURL } = require('url');
const express = require('express');
const { authMiddleware, requireAdmin } = require('../auth');

const router = express.Router();
router.use(authMiddleware);
router.use(requireAdmin);

const WORKSPACE_MODULE = path.resolve(
  __dirname,
  '../../Admin Builder/prototype/src/server.js',
);
const DATA_ROOT = path.resolve(__dirname, '../../admin-builder-data');

let workspacePromise;

function getWorkspace() {
  workspacePromise ??= import(pathToFileURL(WORKSPACE_MODULE).href).then((module) =>
    module.createBuilderWorkspace({ dataRoot: DATA_ROOT }),
  );
  return workspacePromise;
}

function sendError(res, error) {
  const statusCode =
    error.code === 'REQUEST_TOO_LARGE'
      ? 413
      : error.code === 'PROFILE_NOT_FOUND' || error.code === 'PREVIEW_NOT_FOUND'
        ? 404
        : error.code === 'OUTPUT_ALREADY_EXISTS'
          ? 409
          : error.code === 'ENOENT'
            ? 404
            : error.code
              ? 400
              : 500;
  if (statusCode === 500) {
    console.error('[admin-builder]', error.stack || error.message);
  }
  return res.status(statusCode).json({
    ok: false,
    error: error.message || 'Admin Builder request failed.',
    code: error.code || 'INTERNAL_ERROR',
  });
}

router.get('/profiles', async (_req, res) => {
  try {
    const workspace = await getWorkspace();
    const profiles = await workspace.listProfiles();
    return res.json({ ok: true, profiles });
  } catch (error) {
    return sendError(res, error);
  }
});

router.post('/process', async (req, res) => {
  try {
    const workspace = await getWorkspace();
    const result = await workspace.process({
      sourceDataUrl: req.body?.sourceDataUrl,
      datetimeLocal: req.body?.datetimeLocal,
      profileId: req.body?.profileId,
      timezone: req.body?.timezone || 'Asia/Kolkata',
      operatorEmail: req.user.email,
    });
    if (!result?.output_image_base64) {
      return res.status(500).json({
        ok: false,
        error: 'Processor did not return an image.',
        code: 'EMPTY_OUTPUT',
      });
    }
    if (result.source_sha256 === result.output_sha256) {
      return res.status(500).json({
        ok: false,
        error: 'Processor returned an unchanged image.',
        code: 'UNCHANGED_OUTPUT',
      });
    }
    return res.json({ ok: true, ...result });
  } catch (error) {
    return sendError(res, error);
  }
});

router.post('/previews/:previewId/save', async (req, res) => {
  try {
    const workspace = await getWorkspace();
    const result = await workspace.save(req.params.previewId);
    return res.json({ ok: true, ...result });
  } catch (error) {
    return sendError(res, error);
  }
});

router.get('/saved', async (_req, res) => {
  try {
    const workspace = await getWorkspace();
    const images = await workspace.list();
    return res.json({ ok: true, images });
  } catch (error) {
    return sendError(res, error);
  }
});

router.post('/saved/delete', async (req, res) => {
  try {
    const workspace = await getWorkspace();
    const result = await workspace.deleteSaved(req.body?.ids);
    return res.json({ ok: true, ...result });
  } catch (error) {
    return sendError(res, error);
  }
});

router.delete('/saved/:id', async (req, res) => {
  try {
    const workspace = await getWorkspace();
    const result = await workspace.deleteSaved([req.params.id]);
    return res.json({ ok: true, ...result });
  } catch (error) {
    return sendError(res, error);
  }
});

router.get('/saved/:id', async (req, res) => {
  try {
    const workspace = await getWorkspace();
    const saved = await workspace.readSaved(req.params.id);
    return res.json({ ok: true, manifest: saved.manifest });
  } catch (error) {
    return sendError(res, error);
  }
});

router.get('/saved/:id/image', async (req, res) => {
  try {
    const workspace = await getWorkspace();
    const saved = await workspace.readSaved(req.params.id);
    const contentType = saved.manifest.output_format === 'jpeg' ? 'image/jpeg' : 'image/png';
    res.set({
      'Content-Type': contentType,
      'Content-Disposition': `inline; filename="${saved.filename}"`,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    return res.send(saved.image);
  } catch (error) {
    return sendError(res, error);
  }
});

module.exports = router;
