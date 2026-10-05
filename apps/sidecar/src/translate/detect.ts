/**
 * Cheap, deterministic language triage for live chat (WS20-14). It answers one
 * question — "is this probably NOT Romanian?" — in microseconds, so only
 * likely-foreign lines ever cost a codai call. It errs towards "Romanian":
 * a missed translation is harmless, a translated Romanian line is noise.
 */

export interface Detection {
    /** ISO 639-1 guess, "ro", or "und" when there is not enough signal. */
    lang: string;
    foreign: boolean;
}

const RO_DIACRITICS = /[ăâîșțşţĂÂÎȘȚŞŢ]/u;

const SCRIPTS: ReadonlyArray<readonly [RegExp, string]> = [
    [/\p{Script=Cyrillic}/u, "ru"],
    [/\p{Script=Arabic}/u, "ar"],
    [/\p{Script=Hebrew}/u, "he"],
    [/\p{Script=Greek}/u, "el"],
    [/[\p{Script=Hiragana}\p{Script=Katakana}]/u, "ja"],
    [/\p{Script=Hangul}/u, "ko"],
    [/\p{Script=Han}/u, "zh"],
    [/\p{Script=Thai}/u, "th"],
    [/\p{Script=Devanagari}/u, "hi"],
];

/** Distinctive function words; overlapping words across languages are left out. */
const STOPWORDS: Readonly<Record<string, readonly string[]>> = {
    ro: [
        "si", "sau", "este", "sunt", "nu", "da", "ce", "care", "cum", "unde", "cand", "pentru", "foarte", "mai", "asta",
        "aici", "acum", "ma", "te", "esti", "eu", "tu", "noi", "voi", "ei", "lui", "lor", "meu", "tau", "bine", "salut",
        "multumesc", "frumos", "frumoasa", "ai", "am", "ati", "avem", "fost", "fi", "pe", "cu", "din", "la", "un", "o",
        "una", "unei", "unui", "nimic", "ceva", "doar", "dar", "deci", "atunci", "acolo", "buna", "seara", "ziua", "fac",
        "faci", "vreau", "poti", "pot", "stiu", "zi", "hai", "mersi", "iti", "imi", "sa", "ca", "dupa", "inca", "nici",
    ],
    en: [
        "the", "and", "you", "your", "are", "is", "what", "where", "when", "how", "why", "this", "that", "with", "have",
        "from", "they", "will", "would", "could", "should", "hello", "hi", "thanks", "thank", "please", "love", "beautiful",
        "where", "my", "me", "it's", "i'm", "don't", "can", "who", "very", "much", "good", "nice", "of", "to", "in", "for",
    ],
    es: ["el", "los", "las", "que", "por", "como", "pero", "muy", "hola", "gracias", "eres", "estoy", "donde", "y", "una", "del", "mucho", "bonita", "quiero"],
    it: ["il", "che", "sono", "ciao", "grazie", "bella", "molto", "perche", "come", "della", "questo", "anche", "sei", "dove", "voglio"],
    fr: ["le", "les", "des", "est", "et", "je", "vous", "bonjour", "merci", "tres", "avec", "pour", "pas", "c'est", "belle", "tu"],
    de: ["der", "die", "das", "und", "ich", "nicht", "ist", "du", "hallo", "danke", "sehr", "schon", "mit", "wie", "auch", "bist"],
    pt: ["voce", "nao", "obrigado", "obrigada", "muito", "linda", "com", "para", "uma", "tudo", "bem", "oi", "estou"],
    tr: ["ve", "bir", "bu", "cok", "merhaba", "tesekkurler", "nasilsin", "guzel", "ben", "sen", "degil", "var", "yok"],
    hu: ["es", "hogy", "nem", "szia", "koszonom", "nagyon", "szep", "vagy", "igen", "mert", "ez", "az"],
    pl: ["jest", "nie", "czesc", "dziekuje", "bardzo", "ale", "jak", "tak", "sie", "pani", "jestem"],
};

/** Words that are frequent in several languages; never count them. */
const AMBIGUOUS = new Set(["a", "e", "o", "i", "la", "de", "un", "in", "si", "da", "no", "me", "te", "tu", "ce", "ai", "am", "es", "per", "con", "pe"]);

const WORD_SETS: ReadonlyArray<readonly [string, ReadonlySet<string>]> = Object.entries(STOPWORDS).map(
    ([lang, words]) => [lang, new Set(words.filter((w) => !AMBIGUOUS.has(w)))] as const,
);

function fold(text: string): string {
    return text.normalize("NFD").replace(/\p{M}+/gu, "").toLowerCase();
}

export function letterCount(text: string): number {
    return (text.match(/\p{L}/gu) ?? []).length;
}

export function detectLanguage(text: string, minLetters = 6): Detection {
    if (letterCount(text) < minLetters) return { lang: "und", foreign: false };
    if (RO_DIACRITICS.test(text)) return { lang: "ro", foreign: false };
    for (const [pattern, lang] of SCRIPTS) {
        if (pattern.test(text)) return { lang, foreign: true };
    }

    // Strip @mentions and URLs: handles carry no language signal.
    const words = fold(text.replace(/@\S+|https?:\/\/\S+/g, " "))
        .split(/[^\p{L}']+/u)
        .filter((w) => w.length > 0);
    if (words.length === 0) return { lang: "und", foreign: false };

    let best = "und";
    let bestHits = 0;
    let roHits = 0;
    for (const [lang, set] of WORD_SETS) {
        let hits = 0;
        for (const word of words) if (set.has(word)) hits += 1;
        if (lang === "ro") roHits = hits;
        else if (hits > bestHits) {
            best = lang;
            bestHits = hits;
        }
    }
    // Need a clear margin over Romanian, and at least two hits on longer lines.
    const needed = words.length >= 4 ? 2 : 1;
    if (bestHits >= needed && bestHits > roHits) return { lang: best, foreign: true };
    return { lang: roHits > 0 ? "ro" : "und", foreign: false };
}
