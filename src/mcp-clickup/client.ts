const BASE_URL = 'https://api.clickup.com/api/v2';

function getToken(): string {
  const token = process.env.CLICKUP_TOKEN;
  if (!token) throw new Error('CLICKUP_TOKEN environment variable is required');
  return token;
}

async function request(method: string, path: string, body?: unknown): Promise<unknown> {
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: {
      Authorization: getToken(),
      'Content-Type': 'application/json',
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`ClickUp API error ${res.status}: ${text}`);
  }

  return res.json();
}

// ---- Read ----

export async function getWorkspace(): Promise<{ id: string; name: string }> {
  const data = await request('GET', '/team') as { teams: Array<{ id: string; name: string }> };
  const team = data.teams[0];
  if (!team) throw new Error('No ClickUp workspace found');
  return team;
}

export async function getList(listId: string): Promise<{ id: string; name: string; statuses: Array<{ status: string; color: string }> }> {
  const data = await request('GET', `/list/${listId}`) as {
    id: string;
    name: string;
    statuses: Array<{ status: string; color: string }>;
  };
  return data;
}

export async function listTasks(
  listId: string,
  opts: { status?: string; assignees?: string[]; page?: number } = {},
): Promise<ClickUpTask[]> {
  const params = new URLSearchParams({ order_by: 'updated', limit: '50' });
  if (opts.status) params.set('statuses[]', opts.status);
  if (opts.page) params.set('page', String(opts.page));
  const data = await request('GET', `/list/${listId}/task?${params}`) as { tasks: ClickUpTask[] };
  return data.tasks ?? [];
}

export async function getTask(taskId: string): Promise<ClickUpTask> {
  return await request('GET', `/task/${taskId}`) as ClickUpTask;
}

// ---- Write ----

export async function createTask(
  listId: string,
  fields: {
    name: string;
    description?: string;
    status?: string;
    priority?: number;
    due_date?: number;
    assignees?: number[];
  },
): Promise<ClickUpTask> {
  return await request('POST', `/list/${listId}/task`, fields) as ClickUpTask;
}

export async function updateTask(
  taskId: string,
  fields: {
    name?: string;
    description?: string;
    status?: string;
    priority?: number;
    due_date?: number;
  },
): Promise<ClickUpTask> {
  return await request('PUT', `/task/${taskId}`, fields) as ClickUpTask;
}

export async function addComment(taskId: string, commentText: string): Promise<{ id: string }> {
  const data = await request('POST', `/task/${taskId}/comment`, { comment_text: commentText }) as { id: string };
  return data;
}

// ---- Shared types ----

export interface ClickUpTask {
  id: string;
  name: string;
  description?: string;
  status: { status: string; color: string };
  priority?: { priority: string; color: string } | null;
  creator: { id: number; username: string };
  assignees: Array<{ id: number; username: string; email: string }>;
  due_date?: string | null;
  date_created: string;
  date_updated: string;
  url: string;
  list: { id: string; name: string };
}
