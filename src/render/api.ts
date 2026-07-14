import {
  AuthLoginRequest,
  AuthSessionResponse,
  GoogleAuthRequest,
  CreateJobResponse,
  JobStateResponse,
  RenderSpec,
  ApiError,
  UploadSessionResponse,
} from '../../shared/render-contract';

const API_BASE = '/api/jobs';
const AUTH_BASE = '/api/auth';

export const getAuthSession = async (): Promise<AuthSessionResponse> => {
  const response = await fetch(`${AUTH_BASE}/session`, {
    credentials: 'include',
  });

  if (!response.ok) {
    const error = await parseErrorResponse(response);
    throw new Error(error.message);
  }

  return response.json();
};

export const login = async (params: AuthLoginRequest): Promise<AuthSessionResponse> => {
  const response = await fetch(`${AUTH_BASE}/login`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });

  if (!response.ok) {
    const error = await parseErrorResponse(response);
    throw new Error(error.message);
  }

  return response.json();
};

export const loginWithGoogle = async (params: GoogleAuthRequest): Promise<AuthSessionResponse> => {
  const response = await fetch(`${AUTH_BASE}/google`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });

  if (!response.ok) {
    const error = await parseErrorResponse(response);
    throw new Error(error.message);
  }

  return response.json();
};

export const logout = async (): Promise<void> => {
  const response = await fetch(`${AUTH_BASE}/logout`, {
    method: 'POST',
    credentials: 'include',
  });

  if (!response.ok) {
    const error = await parseErrorResponse(response);
    throw new Error(error.message);
  }
};

export const createUploadSession = async (params: {
  foregroundFile: File;
  backgroundVideoFile?: File | null;
  backgroundImageFile?: File | null;
}): Promise<UploadSessionResponse> => {
  const body = new FormData();
  body.append('foreground', params.foregroundFile);

  if (params.backgroundVideoFile) {
    body.append('backgroundVideo', params.backgroundVideoFile);
  }

  if (params.backgroundImageFile) {
    body.append('backgroundImage', params.backgroundImageFile);
  }

  const response = await fetch(`${API_BASE}/uploads`, {
    method: 'POST',
    credentials: 'include',
    body,
  });

  if (!response.ok) {
    const error = await parseErrorResponse(response);
    throw new Error(error.message);
  }

  return response.json();
};

async function parseErrorResponse(response: Response): Promise<ApiError> {
  const contentType = response.headers.get('content-type');
  if (contentType?.includes('application/json')) {
    const json = await response.json() as ApiError;
    if (json.error && json.message) {
      return json;
    }
  }
  // Fallback to text
  const text = await response.text();
  return {
    error: 'Error',
    message: text || `Request failed with status ${response.status}`,
  };
}

export const createRenderJob = async (params: {
  spec: RenderSpec;
  foregroundFile?: File;
  uploadId?: string;
  backgroundVideoFile?: File | null;
  backgroundImageFile?: File | null;
  overlayPng?: Blob | null;
}): Promise<CreateJobResponse> => {
  if (!params.uploadId && !params.foregroundFile) {
    throw new Error('Either uploadId or foregroundFile is required');
  }

  const body = new FormData();
  body.append('spec', JSON.stringify(params.spec));

  if (params.uploadId) {
    body.append('uploadId', params.uploadId);
  }

  if (params.foregroundFile) {
    body.append('foreground', params.foregroundFile);
  }

  if (params.backgroundVideoFile) {
    body.append('backgroundVideo', params.backgroundVideoFile);
  }

  if (params.backgroundImageFile) {
    body.append('backgroundImage', params.backgroundImageFile);
  }

  if (params.overlayPng) {
    body.append('overlay', params.overlayPng, 'overlay.png');
  }

  const response = await fetch(API_BASE, {
    method: 'POST',
    credentials: 'include',
    body,
  });

  if (!response.ok) {
    const error = await parseErrorResponse(response);
    throw new Error(error.message);
  }

  return response.json();
};

export const getRenderJob = async (jobId: string): Promise<JobStateResponse> => {
  const response = await fetch(`${API_BASE}/${jobId}`, {
    credentials: 'include',
  });
  if (!response.ok) {
    const error = await parseErrorResponse(response);
    throw new Error(error.message);
  }
  return response.json();
};

export const cancelRenderJob = async (jobId: string): Promise<void> => {
  const response = await fetch(`${API_BASE}/${jobId}`, {
    method: 'DELETE',
    credentials: 'include',
  });

  if (!response.ok) {
    const error = await parseErrorResponse(response);
    throw new Error(error.message);
  }
};

export const downloadRenderJob = async (jobId: string): Promise<Blob> => {
  const response = await fetch(`${API_BASE}/${jobId}/download`, {
    credentials: 'include',
  });
  if (!response.ok) {
    const error = await parseErrorResponse(response);
    throw new Error(error.message);
  }
  return response.blob();
};

/**
 * Create a trim-only job that trims from a completed job's output (stream copy, no re-encode).
 */
export const createTrimJob = async (params: {
  spec: RenderSpec;
  sourceJobId: string;
}): Promise<CreateJobResponse> => {
  const response = await fetch(`${API_BASE}/trim`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      spec: params.spec,
      sourceJobId: params.sourceJobId,
    }),
  });

  if (!response.ok) {
    const error = await parseErrorResponse(response);
    throw new Error(error.message);
  }

  return response.json();
};
