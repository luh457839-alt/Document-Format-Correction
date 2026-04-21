export interface LogEvent {
  taskId: string;
  stepId: string;
  status: string;
  durationMs: number;
  message?: string;
}

export interface Logger {
  log(event: LogEvent): void;
}

export class JsonConsoleLogger implements Logger {
  log(event: LogEvent): void {
    // eslint-disable-next-line no-console
    console.log(JSON.stringify(event));
  }
}

