import { GAME_KINDS, type GameKind, type GameState } from "@tiksee/core";
import { Button, Card, ChipSelector, StatusPill, TextInput } from "@tiksee/ui";
import { Dices, Play, RotateCcw, Square, Trophy } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { draftToSpec, type GameDraft } from "../../lib/games.js";
import { sidecarClient } from "../../lib/sidecar-client.js";
import { useAppStore } from "../../store/app-store.js";
import { Wheel } from "./wheel.js";

const EMPTY_DRAFT: GameDraft = { kind: "poll", question: "", list: "", keyword: "" };

function Setup() {
    const { t } = useTranslation();
    const [draft, setDraft] = useState<GameDraft>(EMPTY_DRAFT);
    const spec = draftToSpec(draft);
    const patch = (p: Partial<GameDraft>) => setDraft((d) => ({ ...d, ...p }));

    return (
        <form
            className="flex flex-col gap-3"
            onSubmit={(event) => {
                event.preventDefault();
                if (!spec) return;
                sidecarClient.send({ type: "gameStart", game: spec });
                setDraft((d) => ({ ...EMPTY_DRAFT, kind: d.kind }));
            }}
        >
            <ChipSelector<GameKind>
                label={t("games.kind")}
                options={GAME_KINDS}
                value={draft.kind}
                onSelect={(kind) => patch({ kind })}
                display={(k) => t(`games.kinds.${k}`)}
            />
            {draft.kind === "wheel" ? (
                <TextInput
                    label={t("games.keyword")}
                    value={draft.keyword}
                    onChange={(keyword) => patch({ keyword })}
                    placeholder={t("games.keywordPlaceholder")}
                    hint={t("games.keywordHint")}
                />
            ) : (
                <>
                    <TextInput
                        label={t("games.question")}
                        value={draft.question}
                        onChange={(question) => patch({ question })}
                        placeholder={t(draft.kind === "poll" ? "games.pollPlaceholder" : "games.quizPlaceholder")}
                    />
                    <TextInput
                        label={t(draft.kind === "poll" ? "games.options" : "games.answers")}
                        value={draft.list}
                        onChange={(list) => patch({ list })}
                        multiline
                        hint={t(draft.kind === "poll" ? "games.optionsHint" : "games.answersHint")}
                    />
                </>
            )}
            <div>
                <Button type="submit" size="sm" icon={<Play />} disabled={!spec}>
                    {t("games.start")}
                </Button>
            </div>
        </form>
    );
}

function Running({ game }: { game: Exclude<GameState, { kind: "none" }> }) {
    const { t, i18n } = useTranslation();
    const nf = new Intl.NumberFormat(i18n.language);

    return (
        <div className="flex flex-col gap-3">
            {game.kind === "poll" && (
                <>
                    <p className="text-sm font-semibold text-fg">{game.question}</p>
                    <ol className="flex flex-col gap-2">
                        {game.options.map((option, i) => {
                            const pct = game.totalVotes > 0 ? Math.round((option.votes / game.totalVotes) * 100) : 0;
                            return (
                                <li key={i} className="space-y-1">
                                    <div className="flex items-center gap-2 text-xs">
                                        <span className="min-w-0 flex-1 truncate text-fg">
                                            {i + 1}. {option.label}
                                        </span>
                                        <span className="tabular-nums text-fg-muted">
                                            {t("games.votes", { count: option.votes, formatted: nf.format(option.votes) })} · {pct}%
                                        </span>
                                    </div>
                                    <div
                                        role="progressbar"
                                        aria-label={option.label}
                                        aria-valuemin={0}
                                        aria-valuemax={100}
                                        aria-valuenow={pct}
                                        className="h-2 overflow-hidden rounded-full bg-panel-alt"
                                    >
                                        <div className="h-full rounded-full bg-accent transition-[width] duration-500 motion-reduce:transition-none" style={{ width: `${pct}%` }} />
                                    </div>
                                </li>
                            );
                        })}
                    </ol>
                    <p className="text-[0.6875rem] text-fg-muted">
                        {game.open ? t("games.pollHowTo") : t("games.closed")} · {t("games.voters", { count: game.totalVotes, formatted: nf.format(game.totalVotes) })}
                    </p>
                </>
            )}

            {game.kind === "quiz" && (
                <>
                    <p className="text-sm font-semibold text-fg">{game.question}</p>
                    {game.winner ? (
                        <p className="flex items-center gap-2 text-sm text-fg">
                            <Trophy className="size-4 text-[var(--kind-gift)]" aria-hidden />
                            {t("games.quizWinner", { name: game.winner.nickname, answer: game.winner.answer })}
                        </p>
                    ) : (
                        <p className="text-xs text-fg-muted">
                            {game.open ? t("games.quizHowTo") : t("games.quizNobody", { answer: game.answer ?? "" })} ·{" "}
                            {t("games.attempts", { count: game.attempts, formatted: nf.format(game.attempts) })}
                        </p>
                    )}
                </>
            )}

            {game.kind === "wheel" && (
                <>
                    <Wheel
                        segments={game.segments}
                        {...(game.winnerIndex !== undefined ? { winnerIndex: game.winnerIndex } : {})}
                        {...(game.spinAt !== undefined ? { spinAt: game.spinAt } : {})}
                        spinning={game.spinning}
                        label={t("games.wheelLabel", { count: game.entrantCount })}
                    />
                    <p className="text-center text-xs text-fg-muted" aria-live="polite">
                        {game.winner
                            ? t("games.wheelWinner", { name: game.winner.nickname })
                            : game.spinning
                              ? t("games.spinning")
                              : t("games.wheelHowTo", { keyword: game.keyword, count: game.entrantCount, formatted: nf.format(game.entrantCount) })}
                    </p>
                </>
            )}

            <div className="flex flex-wrap gap-2">
                {game.kind === "wheel" && !game.spinning && !game.winner && (
                    <Button size="sm" icon={<Dices />} disabled={game.entrantCount === 0} onClick={() => sidecarClient.send({ type: "gameAction", action: "spin" })}>
                        {t("games.spin")}
                    </Button>
                )}
                {game.kind !== "wheel" && game.open && (
                    <Button size="sm" variant="soft" icon={<Square />} onClick={() => sidecarClient.send({ type: "gameAction", action: "close" })}>
                        {t("games.close")}
                    </Button>
                )}
                <Button size="sm" variant="ghost" icon={<RotateCcw />} onClick={() => sidecarClient.send({ type: "gameAction", action: "clear" })}>
                    {t("games.newGame")}
                </Button>
            </div>
        </div>
    );
}

/** Chat games control (WS20-13): set up, watch and finish a poll, quiz or wheel. */
export function GamesCard() {
    const { t } = useTranslation();
    const game = useAppStore((s) => s.game);

    return (
        <Card
            title={t("games.title")}
            icon={<Dices />}
            tint="var(--kind-join)"
            actions={game.kind !== "none" ? <StatusPill tone="accent">{t(`games.kinds.${game.kind}`)}</StatusPill> : undefined}
        >
            {game.kind === "none" ? <Setup /> : <Running game={game} />}
        </Card>
    );
}
