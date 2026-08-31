export type EdgerunnerPrimitive = string | number | boolean | null;

export type EdgerunnerJson =
  | EdgerunnerPrimitive
  | EdgerunnerJson[]
  | { [key: string]: EdgerunnerJson };

export type EdgerunnerJsonObject = {
  [key: string]: EdgerunnerJson | undefined;
};

export type EdgerunnerConfigResponse = {
  enabled: boolean;
  protocol: string;
  profiles?: EdgerunnerProfile[];
  events: {
    transport: string;
    nativeTransport: string;
  };
};

export type EdgerunnerHealthResponse = {
  ok: boolean;
  edgerunner?: EdgerunnerJson;
};

export type EdgerunnerRunOptions = EdgerunnerJsonObject & {
  validate?: string;
  retention?: 'delete' | 'snapshot' | 'keep' | string;
  model?: string;
  agent?: string;
  auto_approve?: boolean;
  timeout_seconds?: number;
};

export type EdgerunnerCreateSessionRequest = EdgerunnerJsonObject & {
  profile_id?: string;
  repo_url?: string;
  ref?: string;
  prompt?: string;
  auto_start?: boolean;
  labels?: Record<string, string>;
};

export type EdgerunnerProfile = {
  id: string;
  label: string;
  description?: string;
};

export type EdgerunnerRepository = {
  id: string;
  name: string;
  full_name: string;
  private: boolean;
  default_branch: string;
  html_url?: string;
  clone_url?: string;
  ssh_url?: string;
  pushed_at?: string;
  owner?: string;
};

export type EdgerunnerRepositoriesResponse = {
  credentialPresent: boolean;
  repositories: EdgerunnerRepository[];
  message?: string;
};

export type EdgerunnerBranch = {
  name: string;
  sha?: string;
  protected?: boolean;
};

export type EdgerunnerBranchesResponse = {
  credentialPresent: boolean;
  branches: EdgerunnerBranch[];
  message?: string;
};

export type EdgerunnerSession = EdgerunnerJsonObject & {
  id: string;
  title?: string;
  status?: string;
  run_id?: string;
  repo_url?: string;
  ref?: string;
  model?: string;
  agent?: string;
  labels?: Record<string, string>;
  created_at?: number;
  updated_at?: number;
  completed_at?: number;
};

export type EdgerunnerSessionsResponse =
  | EdgerunnerSession[]
  | {
      sessions?: EdgerunnerSession[];
      data?: EdgerunnerSession[];
    };

export type EdgerunnerEvent = EdgerunnerJsonObject & {
  id?: number | string;
  kind?: string;
  message?: string;
  run_id?: string;
  ts?: number;
  created_at?: number;
};

export type EdgerunnerEventsResponse =
  | EdgerunnerEvent[]
  | {
      events?: EdgerunnerEvent[];
      data?: EdgerunnerEvent[];
    };

export type EdgerunnerLogsResponse = EdgerunnerJsonObject & {
  session_id?: string;
  run_id?: string;
  available?: boolean;
  lines?: string[];
};

export type EdgerunnerArtifact = EdgerunnerJsonObject & {
  name?: string;
  kind?: string;
  content_type?: string;
  data?: EdgerunnerJson;
  created_at?: number;
};

export type EdgerunnerArtifactsResponse =
  | EdgerunnerArtifact[]
  | (EdgerunnerJsonObject & {
      session_id?: string;
      run_id?: string;
      items?: EdgerunnerArtifact[];
      data?: EdgerunnerArtifact[];
    });

export type EdgerunnerMessageAction = {
  type: 'message';
  message: EdgerunnerJsonObject & {
    content: string;
    start_run?: boolean;
    role?: 'user' | 'system' | string;
    run?: EdgerunnerRunOptions;
  };
};

export type EdgerunnerControlAction =
  | (EdgerunnerJsonObject & { type: 'approve'; decision?: EdgerunnerJsonObject })
  | (EdgerunnerJsonObject & { type: 'cancel'; reason?: string })
  | (EdgerunnerJsonObject & { type: 'suspend'; reason?: string })
  | (EdgerunnerJsonObject & { type: 'resume' });

export type EdgerunnerActionRequest = EdgerunnerMessageAction | EdgerunnerControlAction;

export type EdgerunnerActionVariables = {
  sessionId: string;
  action: EdgerunnerActionRequest;
};
