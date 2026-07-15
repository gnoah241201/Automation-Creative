import express from 'express';

type HttpErrorLike = {
  status?: unknown;
  type?: unknown;
};

const publicError = (error: unknown): {
  status: number;
  body: { error: string; message: string };
} => {
  const value = error && typeof error === 'object' ? error as HttpErrorLike : {};
  const status = typeof value.status === 'number' ? value.status : 500;
  const type = typeof value.type === 'string' ? value.type : '';

  if (status === 413 || type === 'entity.too.large') {
    return { status: 413, body: { error: 'RequestTooLarge', message: 'Request body is too large' } };
  }
  if (status === 415 || type === 'charset.unsupported' || type === 'encoding.unsupported') {
    return {
      status: 415,
      body: { error: 'UnsupportedMediaType', message: 'Request content type is not supported' },
    };
  }
  if (status === 400 || type === 'entity.parse.failed') {
    return { status: 400, body: { error: 'BadRequest', message: 'Request could not be processed' } };
  }
  return {
    status: 500,
    body: { error: 'InternalServerError', message: 'Request could not be completed' },
  };
};

export const safeApplicationErrorHandler: express.ErrorRequestHandler = (error, _req, res, next) => {
  if (res.headersSent) {
    next(error);
    return;
  }
  const response = publicError(error);
  if (response.status === 500) console.error('[server] Unhandled request error');
  res.status(response.status).json(response.body);
};
