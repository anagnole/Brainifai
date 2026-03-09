import { logger } from '../../shared/logger.js';
import type { ClickUpTask, ClickUpComment, ClickUpDoc, ClickUpTaskActivity } from './types.js';

const BASE_URL = 'https://api.clickup.com/api/v2';
const PAGE_SIZE = 100;

export interface ClickUpClient {
  get(path: string, params?: Record<string, string>): Promise<unknown>;
}

export function getClickUpClient(token: string): ClickUpClient {
  async function get(path: string, params?: Record<string, string>): Promise<unknown> {
    const url = new URL(`${BASE_URL}${path}`);
    if (params) {
      for (const [key, value] of Object.entries(params)) {
        url.searchParams.set(key, value);
      }
    }
    const response = await fetch(url.toString(), {
      headers: { Authorization: token },
    });
    if (!response.ok) {
      throw new Error(`ClickUp API error ${response.status}: ${await response.text()}`);
    }
    return response.json();
  }
  return { get };
}

export async function verifyAuth(client: ClickUpClient): Promise<{ userId: string; workspaceId: string; workspaceName: string }> {
  const data = await client.get('/user') as { user: { id: number; username: string }; teams?: Array<{ id: string }> };
  const user = data.user;

  // Get workspace (team) id and name
  const teams = await client.get('/team') as { teams: Array<{ id: string; name: string }> };
  const workspace = teams.teams[0];
  if (!workspace?.id) throw new Error('No ClickUp workspace found');

  logger.info({ username: user.username, workspaceId: workspace.id }, 'ClickUp auth verified');
  return { userId: String(user.id), workspaceId: workspace.id, workspaceName: workspace.name };
}

export async function getListInfo(
  client: ClickUpClient,
  listId: string,
): Promise<{ name: string; spaceId: string }> {
  const data = await client.get(`/list/${listId}`) as { name: string; space: { id: string } };
  return { name: data.name, spaceId: data.space.id };
}

/**
 * Fetch tasks updated since `since` (ISO 8601), paginating automatically.
 */
export async function* fetchTasks(
  client: ClickUpClient,
  listId: string,
  since?: string,
): AsyncGenerator<ClickUpTask[]> {
  // ClickUp uses Unix ms for updated_gt
  const updatedGt = since ? String(new Date(since).getTime()) : undefined;

  let page = 0;
  while (true) {
    const params: Record<string, string> = {
      order_by: 'updated',
      limit: String(PAGE_SIZE),
      page: String(page),
    };
    if (updatedGt) params.updated_gt = updatedGt;

    const data = await client.get(`/list/${listId}/task`, params) as { tasks: ClickUpTask[] };
    const tasks = data.tasks ?? [];

    if (tasks.length === 0) break;
    yield tasks;
    if (tasks.length < PAGE_SIZE) break;
    page++;
  }
}

/**
 * Fetch all comments for a task (ClickUp returns all at once, no pagination).
 */
export async function fetchComments(
  client: ClickUpClient,
  taskId: string,
): Promise<ClickUpComment[]> {
  const data = await client.get(`/task/${taskId}/comment`) as { comments: ClickUpComment[] };
  return data.comments ?? [];
}

/**
 * Fetch status change activity for a task.
 */
/**
 * Returns null if the endpoint is not available on this plan (404),
 * so callers can disable further calls for the rest of the run.
 */
export async function fetchTaskActivity(
  client: ClickUpClient,
  taskId: string,
): Promise<ClickUpTaskActivity[] | null> {
  try {
    const data = await client.get(`/task/${taskId}/activity`) as { activities: ClickUpTaskActivity[] };
    return (data.activities ?? []).filter((a) => a.field === 'status');
  } catch (err: unknown) {
    if (err instanceof Error && err.message.includes('404')) return null;
    throw err;
  }
}

/**
 * Fetch docs for a workspace, paginating via cursor.
 */
export async function* fetchDocs(
  client: ClickUpClient,
  workspaceId: string,
): AsyncGenerator<ClickUpDoc[]> {
  let nextCursor: string | undefined;
  while (true) {
    const params: Record<string, string> = { limit: '50' };
    if (nextCursor) params.cursor = nextCursor;

    const data = await client.get(`/workspaces/${workspaceId}/docs`, params) as {
      docs: ClickUpDoc[];
      next_cursor?: string;
    };

    const docs = data.docs ?? [];
    if (docs.length === 0) break;
    yield docs;

    nextCursor = data.next_cursor;
    if (!nextCursor) break;
  }
}
