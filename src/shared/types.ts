export interface Person {
  person_key: string;       // e.g. "slack:U12345"
  display_name: string;
  source: string;           // "slack"
  source_id: string;        // raw user id
  avatar_url?: string;
}

export interface Activity {
  source: string;           // "slack"
  source_id: string;        // "slack:{channel}:{ts}"
  timestamp: string;        // ISO 8601
  kind: string;             // "message"
  snippet: string;          // truncated text
  url?: string;             // permalink
  thread_ts?: string;       // for threading support
}

export interface Topic {
  name: string;             // lowercased
}

export interface Container {
  source: string;           // "slack"
  container_id: string;     // channel id
  name: string;             // channel name
  kind: string;             // "channel"
  url?: string;
}

export interface SourceAccount {
  source: string;           // "slack"
  account_id: string;       // slack user id
  linked_person_key: string;
}

export interface NormalizedMessage {
  activity: Activity;
  person: Person;
  container: Container;
  account: SourceAccount;
  topics: Topic[];
}
