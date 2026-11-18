import type { AnimeDetail, AnimeSummary, Character, ListKind, Page, Source, Staff } from './domain';

/** Port de catálogo (Kitsu hoy). */
export interface AnimeMetadataProvider {
  id: string;
  list(kind: ListKind, page: number): Promise<Page<AnimeSummary>>;
  search(q: string, page: number): Promise<Page<AnimeSummary>>;
  getAnime(id: string): Promise<AnimeDetail>;
}

/** Enriquecedor por id de MyAnimeList (Jikan). */
export interface AnimeEnricher {
  id: string;
  getCharacters(mal: number): Promise<Character[]>;
  getStaff(mal: number): Promise<Staff[]>;
  /** Números de episodio marcados como relleno o recap. */
  getEpisodeFlags(mal: number): Promise<{ filler: Set<number>; recap: Set<number> }>;
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
