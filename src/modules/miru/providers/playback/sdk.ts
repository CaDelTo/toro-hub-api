import type { BaseProvider } from 'anime-sdk';
import { AppError } from '../../../../shared/errors';
import type { Source } from '../../domain';
import type { AnimePlaybackProvider, AnimeRef } from '../../ports';

/** Errores del SDK (Error a secas) → AppError del módulo, para que el breaker y `failed` los entiendan. */
export const upstream = <T>(id: string, p: Promise<T>) =>
  p.catch((err) => {
    throw err instanceof AppError ? err : new AppError('miru', 'UPSTREAM_ERROR', 502, `${id}: ${err instanceof Error ? err.message : err}`);
  });

/**
 * Adapter genérico para un proveedor de vídeo de anime-sdk. Cada proveedor aporta solo `findEntry`
 * (cómo encontrar la obra exacta); episodios y streams son iguales para todos.
 */
export function fromSdk(sdk: BaseProvider, findEntry: (ref: AnimeRef) => Promise<string | null>): AnimePlaybackProvider {
  const id = sdk.id;
  return {
    id,
    findEntry,
    async getEpisodes(entryId) {
      return (await upstream(id, sdk.fetchContentUnits(entryId))).map((u) => ({
        id: u.id,
        number: u.number,
        title: u.title,
        languages: u.availableLanguages?.filter((l) => l === 'sub' || l === 'dub') ?? ['sub'],
      }));
    },
    // Un stream por idioma que ofrezca el episodio; basta con que uno resuelva.
    async getSources(ep) {
      const langs = ep.languages.length ? ep.languages : (['sub'] as const);
      const results = await Promise.allSettled(langs.map((lang) => upstream(id, sdk.resolveStream(ep.id, lang)).then((res) => ({ lang, res }))));
      const ok = results.flatMap((r) => (r.status === 'fulfilled' ? [r.value] : []));
      if (!ok.length) throw (results[0] as PromiseRejectedResult).reason;
      return ok.flatMap(({ lang, res }) =>
        res.type !== 'video'
          ? []
          : res.streams.map(
              (s): Source => ({
                provider: id,
                url: s.sourceUrl,
                kind: 'hls',
                quality: s.quality,
                // Algunos proveedores devuelven sub cuando no tienen dub: manda lo que dice el stream.
                language: (s.language ?? lang) === 'dub' ? 'dub' : 'sub',
                subtitles: (s.subtitles ?? []).map((t) => ({ language: t.language, label: t.label, url: t.url })),
              }),
            ),
      );
    },
  };
}
