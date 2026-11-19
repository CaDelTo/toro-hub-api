import { withBreaker } from '../../../../shared/breaker';
import { fetchJson } from '../../../../shared/http';
import type { Weekday } from '../../domain';
import type { AnimeEnricher, ScheduleSlot } from '../../ports';

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

type ScheduleAnime = {
  mal_id: number;
  title: string;
  title_english: string | null;
  title_japanese: string | null;
  episodes: number | null;
  images?: { jpg?: { small_image_url?: string; image_url?: string; large_image_url?: string } };
  broadcast?: { day: string | null; time: string | null; timezone: string | null };
};

// "Mondays" → "MONDAY". Jikan da la emisión en hora de Japón.
const WEEKDAY: Record<string, Weekday> = {
  Mondays: 'MONDAY', Tuesdays: 'TUESDAY', Wednesdays: 'WEDNESDAY', Thursdays: 'THURSDAY', Fridays: 'FRIDAY', Saturdays: 'SATURDAY', Sundays: 'SUNDAY',
};
// shortcut: hasta 8 páginas de 25 (200 series); una temporada normal trae ~120 con día y hora.
const MAX_SCHEDULE_PAGES = 8;

function toSlot(a: ScheduleAnime): ScheduleSlot | null {
  const b = a.broadcast;
  const day = b?.day ? WEEKDAY[b.day] : undefined;
  if (!day || !b?.time || !/^\d{2}:\d{2}$/.test(b.time) || (b.timezone && b.timezone !== 'Asia/Tokyo')) return null;
  const i = a.images?.jpg;
  const lg = i?.large_image_url ?? i?.image_url;
  return {
    mal: a.mal_id,
    title: a.title_english ?? a.title,
    alternativeTitles: { romaji: a.title, english: a.title_english, native: a.title_japanese },
    cover: lg ? { sm: i?.small_image_url ?? lg, md: i?.image_url ?? lg, lg } : null,
    episodeCount: a.episodes,
    day,
    time: b.time,
  };
}

export function createJikanEnricher(): AnimeEnricher {
  const get = <T>(path: string, cacheTtl = DAY, timeoutMs?: number) =>
    withBreaker('miru:metadata:jikan', 'miru', () => fetchJson<T>(`${API_URL}${path}`, { module: 'miru', cacheTtl, timeoutMs }));

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
    async getSchedule() {
      const slots = new Map<number, ScheduleSlot>(); // Jikan repite series entre páginas
      for (let page = 1; page <= MAX_SCHEDULE_PAGES; page++) {
        const res = await get<{ data: ScheduleAnime[]; pagination: { has_next_page: boolean } }>(`/schedules?sfw=true&kids=false&limit=25&page=${page}`, 6 * 3600, 15_000); // /schedules sin caché en Jikan pasa de 5 s
        for (const a of res.data) {
          const slot = toSlot(a);
          if (slot) slots.set(slot.mal, slot);
        }
        if (!res.pagination.has_next_page) break;
      }
      return [...slots.values()];
    },
  };
}
