export class ProcessingError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ProcessingError';
    this.code = code;
  }
}
