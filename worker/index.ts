import type { Env } from './env';
import { handleRequest } from './app';

export { CanvasRoom } from './durable-object';

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return handleRequest(request, env);
  },
};
