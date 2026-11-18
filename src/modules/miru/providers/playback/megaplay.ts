import { MegaPlayProvider, type HttpClient } from 'anime-sdk';
import type { AnimePlaybackProvider } from '../../ports';
import { fromSdk, upstream } from './sdk';

/** MegaPlay indexa su catálogo por id de AniList: el mapeo es exacto y cuesta una llamada. Tiene sub y dub. */
export function createMegaPlay(http: HttpClient): AnimePlaybackProvider {
  const sdk = new MegaPlayProvider(http);
  return fromSdk(sdk, async ({ anilist, mal }) => {
    const raw = await upstream(sdk.id, sdk.lookupByMapping({ anilist, ...(mal === null ? {} : { mal }) }));
    return raw && `${sdk.id}:${raw}`;
  });
}
