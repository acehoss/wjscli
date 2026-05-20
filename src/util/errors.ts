export type WikiMcpErrorCode =
  | 'config_parse'
  | 'missing_config'
  | 'network'
  | 'http'
  | 'graphql'
  | 'auth_expired';

export abstract class WikiMcpError extends Error {
  public readonly code: WikiMcpErrorCode;

  constructor(code: WikiMcpErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.code = code;
    this.name = new.target.name;
  }
}

export class ConfigParseError extends WikiMcpError {
  public readonly path: string;

  constructor(path: string, message: string, options?: ErrorOptions) {
    super('config_parse', `${path}: ${message}`, options);
    this.path = path;
  }
}

export class MissingConfigError extends WikiMcpError {
  public readonly path: string;

  constructor(path: string, baseUrl: string) {
    super(
      'missing_config',
      `no JWT on disk for ${baseUrl} (expected at ${path}); run: wjscli ${baseUrl} validate <jwt>`,
    );
    this.path = path;
  }
}

export class NetworkError extends WikiMcpError {
  constructor(message: string, options?: ErrorOptions) {
    super('network', message, options);
  }
}

export class HttpError extends WikiMcpError {
  public readonly status: number;
  public readonly bodyExcerpt: string;

  constructor(status: number, bodyExcerpt: string) {
    super('http', `HTTP ${status} from /graphql: ${bodyExcerpt}`);
    this.status = status;
    this.bodyExcerpt = bodyExcerpt;
  }
}

export type GraphQLErrorEntry = {
  message: string;
  path?: ReadonlyArray<string | number>;
  extensions?: Record<string, unknown>;
};

export class GraphQLError extends WikiMcpError {
  public readonly errors: ReadonlyArray<GraphQLErrorEntry>;

  constructor(errors: ReadonlyArray<GraphQLErrorEntry>) {
    const first = errors[0]?.message ?? '(no error message)';
    const suffix = errors.length > 1 ? ` (+${errors.length - 1} more)` : '';
    super('graphql', `GraphQL error: ${first}${suffix}`);
    this.errors = errors;
  }
}

export class AuthExpiredError extends WikiMcpError {
  public readonly baseUrl: string;

  constructor(baseUrl: string, detail: string) {
    super(
      'auth_expired',
      `Wiki.js rejected the JWT for ${baseUrl} (${detail}). Re-validate with: wjscli ${baseUrl} validate <jwt>`,
    );
    this.baseUrl = baseUrl;
  }
}
