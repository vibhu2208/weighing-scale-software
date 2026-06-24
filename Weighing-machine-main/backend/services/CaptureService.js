'use strict';

const { saveTripCapture } = require('./TripCaptureService');

/** @deprecated use saveTripCapture */
function saveTestCapture(data) {
  return saveTripCapture(data);
}

module.exports = { saveTestCapture, saveTripCapture };
