import { logger } from '../../shared/logger.js';
import type { RawTweet } from './types.js';

// Public bearer token used by twitter.com itself
const BEARER_TOKEN =
  'AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA';

const TWITTER_PAGE_SIZE = 20;

export interface TwitterClient {
  cookies: string;
  csrfToken: string;
  headers: Record<string, string>;
}

let singleton: TwitterClient | null = null;

/**
 * Create (or return cached) Twitter client from raw cookie string.
 * Extracts the ct0 CSRF token from the cookies automatically.
 */
export function getTwitterClient(cookies: string): TwitterClient {
  if (singleton) return singleton;

  // Extract ct0 (CSRF token) from cookie string
  const ct0Match = cookies.match(/ct0=([^;]+)/);
  if (!ct0Match) {
    throw new Error('TWITTER_COOKIES must contain a ct0 cookie (CSRF token)');
  }
  const csrfToken = ct0Match[1];

  const headers: Record<string, string> = {
    authorization: `Bearer ${BEARER_TOKEN}`,
    cookie: cookies,
    'x-csrf-token': csrfToken,
    'x-twitter-active-user': 'yes',
    'x-twitter-auth-type': 'OAuth2Session',
    'x-twitter-client-language': 'en',
    'user-agent':
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    accept: '*/*',
    'accept-language': 'en-US,en;q=0.9',
    'content-type': 'application/json',
  };

  singleton = { cookies, csrfToken, headers };
  return singleton;
}

/**
 * Verify the session is valid by resolving the first configured username.
 * If this succeeds, the cookies are good.
 */
export async function verifyAuth(client: TwitterClient, testUsername?: string): Promise<void> {
  if (!testUsername) {
    // No username to test — just check the cookies have the right shape
    if (!client.csrfToken) {
      throw new Error('Twitter auth verification failed: no ct0 CSRF token');
    }
    logger.info('Twitter auth: cookies present (skipping live check)');
    return;
  }

  // Try resolving a username as a lightweight auth check
  try {
    await resolveUserId(client, testUsername);
    logger.info({ user: testUsername }, 'Twitter auth verified');
  } catch (err) {
    throw new Error(`Twitter auth verification failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ─── Internal helpers ───────────────────────────────────────────────────────

function parseTweetEntry(entry: any, users: Map<string, any>): RawTweet | null {
  try {
    const result =
      entry?.content?.itemContent?.tweet_results?.result ??
      entry?.content?.content?.tweetResult?.result ??
      entry?.item?.itemContent?.tweet_results?.result;

    if (!result) return null;

    // Handle tweet-with-visibility-results wrapper
    const tweetData = result.__typename === 'TweetWithVisibilityResults'
      ? result.tweet
      : result;

    if (!tweetData?.legacy || !tweetData?.core) return null;

    const legacy = tweetData.legacy;
    const userResult = tweetData.core.user_results?.result;
    const userLegacy = userResult?.legacy;

    if (!userLegacy) return null;

    const authorId = userResult.rest_id ?? legacy.user_id_str;

    // Parse URLs from entities
    const urls: string[] = [];
    for (const u of legacy.entities?.urls ?? []) {
      if (u.expanded_url) urls.push(u.expanded_url);
    }

    // Parse media
    const media: Array<{ type: string; url: string }> = [];
    for (const m of legacy.entities?.media ?? []) {
      media.push({ type: m.type ?? 'photo', url: m.expanded_url ?? m.media_url_https });
    }

    return {
      id: legacy.id_str ?? tweetData.rest_id,
      text: legacy.full_text ?? legacy.text ?? '',
      created_at: new Date(legacy.created_at).toISOString(),
      author_id: authorId,
      author_username: userLegacy.screen_name,
      author_display_name: userLegacy.name,
      author_avatar_url: userLegacy.profile_image_url_https,
      conversation_id: legacy.conversation_id_str,
      in_reply_to_id: legacy.in_reply_to_status_id_str ?? undefined,
      quote_tweet_id: tweetData.quoted_status_result?.result?.rest_id ?? undefined,
      retweet_count: legacy.retweet_count ?? 0,
      like_count: legacy.favorite_count ?? 0,
      reply_count: legacy.reply_count ?? 0,
      urls: urls.length > 0 ? urls : undefined,
      media: media.length > 0 ? media : undefined,
    };
  } catch {
    return null;
  }
}

function extractTweetsFromTimeline(data: any): { tweets: RawTweet[]; nextCursor: string | undefined } {
  const tweets: RawTweet[] = [];
  let nextCursor: string | undefined;

  const instructions =
    data?.data?.user?.result?.timeline_v2?.timeline?.instructions ??
    data?.data?.search_by_raw_query?.search_timeline?.timeline?.instructions ??
    [];

  for (const instruction of instructions) {
    const entries = instruction.entries ?? [];
    for (const entry of entries) {
      // Cursor entries
      if (entry.entryId?.startsWith('cursor-bottom-')) {
        nextCursor = entry.content?.value;
        continue;
      }

      // Tweet entries
      if (entry.entryId?.startsWith('tweet-')) {
        const tweet = parseTweetEntry(entry, new Map());
        if (tweet) tweets.push(tweet);
      }

      // Conversation module entries (search results)
      if (entry.entryId?.startsWith('conversationthread-') || entry.content?.items) {
        for (const item of entry.content?.items ?? []) {
          const tweet = parseTweetEntry(item, new Map());
          if (tweet) tweets.push(tweet);
        }
      }
    }
  }

  return { tweets, nextCursor };
}

// ─── GraphQL query IDs (these are public, extracted from twitter.com bundles) ─

const USER_TWEETS_QUERY_ID = 'V7H0Ap3_Hh2FyS75OCDO3Q';
const SEARCH_QUERY_ID = 'gkjsKepM6gl_HmFWoWKfgg';
const USER_BY_SCREEN_NAME_QUERY_ID = 'G3KGOASz96M-Qu0nwmGXNg';

/**
 * Resolve a username to a user rest_id.
 */
async function resolveUserId(client: TwitterClient, username: string): Promise<string> {
  const variables = JSON.stringify({
    screen_name: username,
    withSafetyModeUserFields: true,
  });
  const features = JSON.stringify({
    hidden_profile_subscriptions_enabled: true,
    rweb_tipjar_consumption_enabled: true,
    responsive_web_graphql_exclude_directive_enabled: true,
    verified_phone_label_enabled: false,
    highlights_tweets_tab_ui_enabled: true,
    responsive_web_twitter_article_notes_tab_enabled: true,
    subscriptions_feature_can_gift_premium: true,
    creator_subscriptions_tweet_preview_api_enabled: true,
    responsive_web_graphql_skip_user_profile_image_extensions_enabled: false,
    responsive_web_graphql_timeline_navigation_enabled: true,
  });

  const url = `https://x.com/i/api/graphql/${USER_BY_SCREEN_NAME_QUERY_ID}/UserByScreenName?variables=${encodeURIComponent(variables)}&features=${encodeURIComponent(features)}`;
  const res = await fetch(url, { headers: client.headers });

  if (!res.ok) {
    throw new Error(`Failed to resolve Twitter user @${username}: ${res.status}`);
  }

  const data = (await res.json()) as any;
  const userId = data?.data?.user?.result?.rest_id;
  if (!userId) {
    throw new Error(`Could not resolve Twitter user @${username}`);
  }

  return userId;
}

/**
 * Fetch tweets from a user's timeline. Async generator yielding pages.
 */
export async function* fetchUserTweets(
  client: TwitterClient,
  username: string,
  since: Date,
): AsyncGenerator<RawTweet[]> {
  const userId = await resolveUserId(client, username);
  let cursor: string | undefined;

  while (true) {
    const variables: any = {
      userId,
      count: TWITTER_PAGE_SIZE,
      includePromotedContent: false,
      withQuickPromoteEligibilityTweetFields: true,
      withVoice: true,
      withV2Timeline: true,
    };
    if (cursor) variables.cursor = cursor;

    const features = JSON.stringify({
      rweb_tipjar_consumption_enabled: true,
      responsive_web_graphql_exclude_directive_enabled: true,
      verified_phone_label_enabled: false,
      creator_subscriptions_tweet_preview_api_enabled: true,
      responsive_web_graphql_timeline_navigation_enabled: true,
      responsive_web_graphql_skip_user_profile_image_extensions_enabled: false,
      communities_web_enable_tweet_community_results_fetch: true,
      c9s_tweet_anatomy_moderator_badge_enabled: true,
      articles_preview_enabled: true,
      responsive_web_edit_tweet_api_enabled: true,
      graphql_is_translatable_rweb_tweet_is_translatable_enabled: true,
      view_counts_everywhere_api_enabled: true,
      longform_notetweets_consumption_enabled: true,
      responsive_web_twitter_article_tweet_consumption_enabled: true,
      tweet_awards_web_tipping_enabled: false,
      creator_subscriptions_quote_tweet_preview_enabled: false,
      freedom_of_speech_not_reach_fetch_enabled: true,
      standardized_nudges_misinfo: true,
      tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled: true,
      rweb_video_timestamps_enabled: true,
      longform_notetweets_rich_text_read_enabled: true,
      longform_notetweets_inline_media_enabled: true,
      responsive_web_enhance_cards_enabled: false,
    });

    const url = `https://x.com/i/api/graphql/${USER_TWEETS_QUERY_ID}/UserTweets?variables=${encodeURIComponent(JSON.stringify(variables))}&features=${encodeURIComponent(features)}`;
    const res = await fetch(url, { headers: client.headers });

    if (!res.ok) {
      logger.error({ status: res.status, username }, 'Failed to fetch user tweets');
      break;
    }

    const data = await res.json();
    const { tweets, nextCursor } = extractTweetsFromTimeline(data);

    // Filter to only tweets since the cutoff
    const filtered = tweets.filter((t) => new Date(t.created_at) > since);

    if (filtered.length > 0) {
      yield filtered;
    }

    // Stop if we've gone past the since date or no more pages
    if (!nextCursor || filtered.length < tweets.length) break;
    cursor = nextCursor;
  }
}

/**
 * Search for tweets matching a query. Async generator yielding pages.
 */
export async function* fetchSearchResults(
  client: TwitterClient,
  query: string,
  since: Date,
): AsyncGenerator<RawTweet[]> {
  let cursor: string | undefined;

  while (true) {
    const variables: any = {
      rawQuery: query,
      count: TWITTER_PAGE_SIZE,
      querySource: 'typed_query',
      product: 'Latest',
    };
    if (cursor) variables.cursor = cursor;

    const features = JSON.stringify({
      rweb_tipjar_consumption_enabled: true,
      responsive_web_graphql_exclude_directive_enabled: true,
      verified_phone_label_enabled: false,
      creator_subscriptions_tweet_preview_api_enabled: true,
      responsive_web_graphql_timeline_navigation_enabled: true,
      responsive_web_graphql_skip_user_profile_image_extensions_enabled: false,
      communities_web_enable_tweet_community_results_fetch: true,
      c9s_tweet_anatomy_moderator_badge_enabled: true,
      articles_preview_enabled: true,
      responsive_web_edit_tweet_api_enabled: true,
      graphql_is_translatable_rweb_tweet_is_translatable_enabled: true,
      view_counts_everywhere_api_enabled: true,
      longform_notetweets_consumption_enabled: true,
      responsive_web_twitter_article_tweet_consumption_enabled: true,
      tweet_awards_web_tipping_enabled: false,
      creator_subscriptions_quote_tweet_preview_enabled: false,
      freedom_of_speech_not_reach_fetch_enabled: true,
      standardized_nudges_misinfo: true,
      tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled: true,
      rweb_video_timestamps_enabled: true,
      longform_notetweets_rich_text_read_enabled: true,
      longform_notetweets_inline_media_enabled: true,
      responsive_web_enhance_cards_enabled: false,
    });

    const url = `https://x.com/i/api/graphql/${SEARCH_QUERY_ID}/SearchTimeline?variables=${encodeURIComponent(JSON.stringify(variables))}&features=${encodeURIComponent(features)}`;
    const res = await fetch(url, { headers: client.headers });

    if (!res.ok) {
      logger.error({ status: res.status, query }, 'Failed to fetch search results');
      break;
    }

    const data = await res.json();
    const { tweets, nextCursor } = extractTweetsFromTimeline(data);

    const filtered = tweets.filter((t) => new Date(t.created_at) > since);

    if (filtered.length > 0) {
      yield filtered;
    }

    if (!nextCursor || filtered.length < tweets.length) break;
    cursor = nextCursor;
  }
}
