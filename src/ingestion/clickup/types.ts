export interface ClickUpUser {
  id: string;
  username: string;
  email: string;
  avatar: string | null;
}

export interface ClickUpStatus {
  status: string;
  color: string;
  type: string;
}

export interface ClickUpTask {
  id: string;
  name: string;
  description: string | null;
  status: ClickUpStatus;
  creator: ClickUpUser;
  date_created: string; // Unix ms as string
  date_updated: string; // Unix ms as string
  url: string;
}

export interface ClickUpComment {
  id: string;
  comment_text: string;
  user: ClickUpUser;
  date: string; // Unix ms as string
  resolved: boolean;
}

export interface ClickUpDocParent {
  id: string;
  type: number;
}

export interface ClickUpTaskActivity {
  id: string;
  date: string; // Unix ms as string
  field: string; // e.g. "status", "assignee", etc.
  before: string;
  after: string;
  user: ClickUpUser;
}

export interface ClickUpDoc {
  id: string;
  name: string;
  content: string | null;
  creator: number; // user id
  date_created: string; // Unix ms as string
  date_updated: string; // Unix ms as string
  url?: string;
  parent?: ClickUpDocParent;
}
