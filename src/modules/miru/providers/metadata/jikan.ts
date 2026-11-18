import { withBreaker } from '../../../../shared/breaker';
import { fetchJson } from '../../../../shared/http';
import type { AnimeEnricher } from '../../ports';

const API_URL = 'https://api.jikan.moe/v4';
const DAY = 24 * 3600;
// Jikan limita a 3 req/s: los episodios van de 100 en 100 y se piden en serie.
// shortcut: solo las primeras 5 páginas (500 episodios) traen marcas de relleno; subir si hace falta para series largas.
const MAX_EPISODE_PAGES = 5;

type Img = { jpg?: { image_url?: string | null } };
type Person = { name: string; images?: Img };

// Jikan devuelve un "?" genérico cuando no hay foto.
const image = (i?: Img) => {
  const url = i?.jpg?.image_url;
  return url && !url.includes('questionmark') ? url : null;
};

export function createJikanEnricher(): AnimeEnricher {
  const get = <T>(path: string) => withBreaker('miru:metadata:jikan', 'miru', () => fetchJson<T>(`${API_URL}${path}`, { module: 'miru', cacheTtl: DAY }));

  return {
    id: 'jikan',
    async getCharacters(mal) {
      const { data } = await get<{ data: { character: Person; role: string; voice_actors: { person: Person; language: string }[] }[] }>(`/anime/${mal}/characters`);
      return data.map((c) => ({
        name: c.character.name,
        image: image(c.character.images),
        role: c.role,
        voiceActors: c.voice_actors.map((v) => ({ name: v.person.name, image: image(v.person.images), language: v.language })),
      }));
    },
    async getStaff(mal) {
      const { data } = await get<{ data: { person: Person; positions: string[] }[] }>(`/anime/${mal}/staff`);
      return data.map((s) => ({ name: s.person.name, image: image(s.person.images), positions: s.positions }));
    },
    async getEpisodeFlags(mal) {
      const filler = new Set<number>();
      const recap = new Set<number>();
      for (let page = 1; page <= MAX_EPISODE_PAGES; page++) {
        const res = await get<{ data: { mal_id: number; filler: boolean; recap: boolean }[]; pagination: { has_next_page: boolean } }>(
          `/anime/${mal}/episodes?page=${page}`,
        );
        for (const e of res.data) {
          if (e.filler) filler.add(e.mal_id);
          if (e.recap) recap.add(e.mal_id);
        }
        if (!res.pagination.has_next_page) break;
      }
      return { filler, recap };
    },
  };
}
