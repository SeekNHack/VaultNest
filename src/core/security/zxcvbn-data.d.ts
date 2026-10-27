// Individual zxcvbn-ts data files, imported directly so unused word lists are not bundled.
declare module '@zxcvbn-ts/language-common/dist/adjacencyGraphs.json.mjs' {
  const graphs: import('@zxcvbn-ts/core').OptionsGraph;
  export default graphs;
}
declare module '@zxcvbn-ts/language-common/dist/diceware.json.mjs' {
  const words: string[];
  export default words;
}
declare module '@zxcvbn-ts/language-en/dist/firstnames.json.mjs' {
  const words: string[];
  export default words;
}
declare module '@zxcvbn-ts/language-en/dist/wordSequences.json.mjs' {
  const lists: Record<string, string[]>;
  export default lists;
}
declare module '@zxcvbn-ts/language-en/dist/translations.mjs' {
  const translations: import('@zxcvbn-ts/core').TranslationKeys;
  export default translations;
}
