export interface SlackMessage {
  type: string;
  user?: string;
  text?: string;
  ts: string;
  thread_ts?: string;
  subtype?: string;
  bot_id?: string;
}

export interface SlackChannel {
  id: string;
  name: string;
  is_channel: boolean;
}
