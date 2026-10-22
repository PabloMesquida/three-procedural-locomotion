/** Languages of the UI texts the library provides (basic controls, debugging helpers). */
export type Language = 'en' | 'es';

/** A text in each language. */
export type LocalizedText = Readonly<Record<Language, string>>;
