// Mini runtime de esquemas: reemplaza a @fogon/net. Solo describe la forma del estado (los tipos y valores iniciales).
export interface Field<T> {
  __t?: T;
  kind: string;
}
const f = <T>(kind: string): Field<T> => ({ kind });
export const t = {
  q16: (_step: number) => f<number>("q16"),
  u8: f<number>("u8"),
  u16: f<number>("u16"),
  bool: f<boolean>("bool"),
  str: f<string>("str"),
  angle8: f<number>("angle8"),
};
export type Infer<S> = { [K in keyof S]: S[K] extends Field<infer T> ? T : never };
export const schema = <S extends Record<string, Field<any>>>(s: S) => s;
export interface Def<S, K extends "collection" | "single" = "collection" | "single"> {
  kind: K;
  schema: S;
  opts?: { lerp?: string[]; angle?: string[] };
}
export const collection = <S extends Record<string, Field<any>>>(s: S, opts?: { lerp?: string[]; angle?: string[] }): Def<S, "collection"> => ({ kind: "collection", schema: s, opts });
export const single = <S extends Record<string, Field<any>>>(s: S): Def<S, "single"> => ({ kind: "single", schema: s });
export type StateOf<D extends Record<string, Def<any>>> = {
  [K in keyof D]: D[K]["kind"] extends "collection" ? Map<number, Infer<D[K]["schema"]>> : Infer<D[K]["schema"]>;
};
export interface GameDef<D extends Record<string, Def<any>> = Record<string, Def<any>>> {
  state: D;
  owned: Record<string, { fields: string[]; maxSpeed: number }>;
}
export const defineGame = <D extends Record<string, Def<any>>>(g: GameDef<D>) => g;
