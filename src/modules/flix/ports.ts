import type { Collection, DiscoverQuery, Genre, ListKind, MediaType, Page, Person, Rating, Review, Season, Source, TitleDetail, TitleSummary } from './domain';

/** Port de catálogo. Un adapter por proveedor (TMDB hoy); entra y sale solo el modelo canónico. */
export interface MetadataProvider {
  id: string;
  genres(): Genre[];
  list(kind: ListKind, opts: { type: MediaType | 'all'; page: number; region?: string; window?: 'day' | 'week' }): Promise<Page<TitleSummary>>;
  discover(q: DiscoverQuery): Promise<Page<TitleSummary>>;
  search(q: string, page: number): Promise<Page<TitleSummary>>;
  getTitle(id: string): Promise<TitleDetail>;
  getReviews(id: string, page: number): Promise<Page<Review>>;
  getSeason(id: string, season: number): Promise<Season>;
  getCollection(id: string): Promise<Collection>;
  getPerson(id: string): Promise<Person>;
}

/** Enriquecedor de notas: suma IMDb, RT… al detalle a partir del id de IMDb. Opcional; si falla, el detalle sale igual. */
export interface RatingsEnricher {
  id: string;
  ratings(imdbId: string): Promise<Rating[]>;
}

export type StreamRef = { type: MediaType; tmdb: number; imdb?: string };
export type EpisodeRef = { season: number; episode: number };

/** Port de reproducción. Cada proveedor busca el contenido con el id que necesita (`needs`). */
export interface StreamProvider {
  id: string;
  needs: 'tmdb' | 'imdb';
  getSources(ref: StreamRef, ep?: EpisodeRef): Promise<Source[]>;
}
