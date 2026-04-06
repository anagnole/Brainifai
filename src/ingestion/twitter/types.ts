export interface RawTweet {
  id: string;
  text: string;
  created_at: string;           // ISO 8601
  author_id: string;
  author_username: string;
  author_display_name: string;
  author_avatar_url?: string;
  conversation_id?: string;
  in_reply_to_id?: string;
  quote_tweet_id?: string;
  retweet_count: number;
  like_count: number;
  reply_count: number;
  urls?: string[];
  media?: Array<{ type: string; url: string }>;
}

export interface TwitterUser {
  id: string;
  username: string;
  display_name: string;
  avatar_url?: string;
}
