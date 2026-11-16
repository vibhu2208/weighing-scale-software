'use strict';

const path = require('path');
const { pathToFileURL } = require('url');

const WORKSPACE_MODULE = path.resolve(
  __dirname,
  '../../Admin Builder/prototype/src/server.js',
);
const DATA_ROOT = path.resolve(__dirname, '../../admin-builder-data');

let workspacePromise;

function getAdminBuilderWorkspace() {
  workspacePromise ??= import(pathToFileURL(WORKSPACE_MODULE).href).then((module) =>
    module.createBuilderWorkspace({ dataRoot: DATA_ROOT }),
  );
  return workspacePromise;
}

module.exports = {
  getAdminBuilderWorkspace,
  DATA_ROOT,
};
