import type { AnimeDetail, AnimeSummary, BrowseFilters, Character, ListKind, Page, ScheduleEntry, Source, Staff } from './domain';

/** Port de catálogo (Kitsu hoy). */
export interface AnimeMetadataProvider {
  id: string;
  list(kind: ListKind, page: number): Promise<Page<AnimeSummary>>;
  browse(filters: BrowseFilters, page: number): Promise<Page<AnimeSummary>>;
  search(q: string, page: number): Promise<Page<AnimeSummary>>;
  getAnime(id: string): Promise<AnimeDetail>;
  /** Id canónico por id de MyAnimeList; los que no tienen mapeo no aparecen en el Map. */
  idsFromMal(mal: number[]): Promise<Map<number, string>>;
}

/** Hueco semanal tal como lo da el enriquecedor, antes de tener id canónico. */
export type ScheduleSlot = Omit<ScheduleEntry, 'id'> & { mal: number };

/** Enriquecedor por id de MyAnimeList (Jikan). */
export interface AnimeEnricher {
  id: string;
  getCharacters(mal: number): Promise<Character[]>;
  getStaff(mal: number): Promise<Staff[]>;
  /** Números de episodio marcados como relleno o recap. */
  getEpisodeFlags(mal: number): Promise<{ filler: Set<number>; recap: Set<number> }>;
  /** Series en emisión con su día y hora de emisión (JST). */
  getSchedule(): Promise<ScheduleSlot[]>;
}

/** Lo que un proveedor de vídeo necesita para encontrar la obra exacta. */
export type AnimeRef = { kitsu: number; anilist: number | null; mal: number | null; year: number | null; titles: string[] };

export type EpisodeUnit = { id: string; number: number; title: string; languages: ('sub' | 'dub')[] };

/** Port de reproducción. El id de catálogo no coincide con el del proveedor: cada uno resuelve su entrada. */
export interface AnimePlaybackProvider {
  id: string;
  /** null si el proveedor no tiene esta obra (nunca adivina por título a secas). */
  findEntry(ref: AnimeRef): Promise<string | null>;
  getEpisodes(entryId: string): Promise<EpisodeUnit[]>;
  /** Fuentes de todos los idiomas que ofrezca el episodio. */
  getSources(episode: EpisodeUnit): Promise<Source[]>;
}
