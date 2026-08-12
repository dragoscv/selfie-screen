import { eventDiamonds, initialOf, type ChatEvent } from "@tiksee/core";
import { Button, Card, EmptyState, cn } from "@tiksee/ui";
import { AnimatePresence, motion } from "motion/react";
import { Gift, MessageSquare, Sparkles, Trophy, Users } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { MAIN_STREAM, selectEvents, useAppStore } from "../store/app-store.js";

interface Person {
    uniqueId: string;
    nickname: string;
    avatarUrl?: string;
    messages: number;
    gifts: number;
    diamonds: number;
    firstSeen: number;
    lastSeen: number;
}

/** Fold the event stream into per-viewer aggregates. */
function buildPeople(events: ChatEvent[]): Person[] {
    const map = new Map<string, Person>();

    for (const event of events) {
        const key = event.user.uniqueId || event.user.nickname;
        if (key === "") continue;

        let person = map.get(key);
        if (!person) {
            person = {
                uniqueId: key,
                nickname: event.user.nickname,
                avatarUrl: event.user.avatarUrl,
                messages: 0,
                gifts: 0,
                diamonds: 0,
                firstSeen: event.at,
                lastSeen: event.at,
            };
            map.set(key, person);
        }

        // Keep the freshest avatar; TikTok rotates CDN URLs.
        if (event.user.avatarUrl) person.avatarUrl = event.user.avatarUrl;
        person.lastSeen = Math.max(person.lastSeen, event.at);
        if (event.kind === "chat") person.messages += 1;
        if (event.kind === "gift") {
            person.gifts += event.giftCount ?? 1;
            person.diamonds += eventDiamonds(event);
        }
    }

    return [...map.values()];
}

export function PeopleRoute() {
    const { t } = useTranslation();
    const events = useAppStore(selectEvents(MAIN_STREAM));
    const people = useMemo(() => buildPeople(events), [events]);

    const mostActive = useMemo(
        () => [...people].sort((a, b) => b.messages - a.messages || b.lastSeen - a.lastSeen).slice(0, 25),
        [people],
    );
    const topGifters = useMemo(
        () => people.filter((p) => p.diamonds > 0).sort((a, b) => b.diamonds - a.diamonds).slice(0, 10),
        [people],
    );

    if (people.length === 0) {
        return (
            <div className="grid h-full place-items-center">
                <EmptyState icon={<Users />} title={t("people.empty")} description={t("people.emptyHint")} />
            </div>
        );
    }

    return (
        <div className="@container h-full overflow-y-auto p-5">
            <div className="mx-auto grid max-w-[110rem] gap-3 @3xl:grid-cols-2 @6xl:grid-cols-3">
                <Card title={t("people.mostActive")} icon={<MessageSquare />} className="@3xl:row-span-2">
                    <ul className="space-y-1">
                        {mostActive.map((person) => (
                            <PersonRow key={person.uniqueId} person={person} />
                        ))}
                    </ul>
                </Card>

                <Card title={t("people.topGifters")} icon={<Trophy />} tint="var(--kind-gift)">
                    {topGifters.length === 0 ? (
                        <p className="text-xs text-fg-subtle">{t("analytics.noGifts")}</p>
                    ) : (
                        <ul className="space-y-1">
                            {topGifters.map((person, index) => (
                                <PersonRow key={person.uniqueId} person={person} rank={index + 1} />
                            ))}
                        </ul>
                    )}
                </Card>

                <GiveawayCard people={people} />
            </div>
        </div>
    );
}

function PersonRow({ person, rank }: { person: Person; rank?: number }) {
    const { t } = useTranslation();
    return (
        <li className="flex items-center gap-2.5 rounded-[--radius-chip] px-2 py-1.5 transition-colors hover:bg-panel-alt">
            {rank !== undefined && (
                <span
                    className={cn(
                        "w-5 shrink-0 text-center text-xs font-bold tabular-nums",
                        rank === 1 ? "text-kind-gift" : "text-fg-subtle",
                    )}
                >
                    {rank}
                </span>
            )}
            {person.avatarUrl ? (
                <img src={person.avatarUrl} alt="" loading="lazy" className="size-7 shrink-0 rounded-full object-cover" />
            ) : (
                <span className="grid size-7 shrink-0 place-items-center rounded-full bg-accent-subtle text-xs font-bold text-accent">
                    {initialOf(person.nickname)}
                </span>
            )}
            <div className="min-w-0 flex-1">
                <p className="truncate text-[0.8125rem] font-medium text-fg">{person.nickname}</p>
                <p className="truncate text-[0.6875rem] text-fg-muted">
                    {t("people.messages", { count: person.messages })}
                    {person.gifts > 0 && ` · ${t("people.gifts", { count: person.gifts })}`}
                    {person.diamonds > 0 && ` · ${person.diamonds.toLocaleString()} 💎`}
                </p>
            </div>
        </li>
    );
}

function GiveawayCard({ people }: { people: Person[] }) {
    const { t } = useTranslation();
    const [winner, setWinner] = useState<Person | null>(null);
    const [rolling, setRolling] = useState(false);
    const timerRef = useRef<number | null>(null);

    // The roll is a 1s interval; navigating away mid-draw would otherwise
    // leave it ticking against an unmounted tree.
    useEffect(
        () => () => {
            if (timerRef.current !== null) window.clearInterval(timerRef.current);
        },
        [],
    );

    // Only viewers who actually chatted are eligible — passive joins are bots
    // as often as not.
    const eligible = useMemo(() => people.filter((p) => p.messages > 0), [people]);

    const draw = () => {
        if (eligible.length === 0 || rolling) return;
        setRolling(true);
        setWinner(null);

        // Shuffle visibly for a moment; an instant result feels rigged on stream.
        let ticks = 0;
        const timer = window.setInterval(() => {
            const pick = eligible[Math.floor(Math.random() * eligible.length)];
            if (pick) setWinner(pick);
            ticks += 1;
            if (ticks >= 14) {
                window.clearInterval(timer);
                timerRef.current = null;
                // crypto.getRandomValues is the honest choice for the final pick.
                const buffer = new Uint32Array(1);
                crypto.getRandomValues(buffer);
                const index = (buffer[0] ?? 0) % eligible.length;
                setWinner(eligible[index] ?? null);
                setRolling(false);
            }
        }, 70);
        timerRef.current = timer;
    };

    return (
        <Card
            title={t("people.giveaway")}
            subtitle={t("people.giveawayHint")}
            icon={<Sparkles />}
            tint="var(--kind-follow)"
        >
            <p className="text-xs text-fg-muted">{t("people.eligible", { count: eligible.length })}</p>

            <div className="grid min-h-24 place-items-center rounded-[--radius-panel] bg-panel-alt p-4">
                <AnimatePresence mode="wait">
                    {winner ? (
                        <motion.div
                            key={winner.uniqueId + String(rolling)}
                            initial={{ opacity: 0, scale: 0.9 }}
                            animate={{ opacity: 1, scale: 1 }}
                            exit={{ opacity: 0, scale: 1.05 }}
                            transition={{ duration: 0.12 }}
                            className="flex flex-col items-center gap-2"
                        >
                            {winner.avatarUrl ? (
                                <img src={winner.avatarUrl} alt="" className="size-12 rounded-full object-cover" />
                            ) : (
                                <span className="grid size-12 place-items-center rounded-full bg-accent-subtle text-lg font-bold text-accent">
                                    {initialOf(winner.nickname)}
                                </span>
                            )}
                            <p className="text-sm font-bold text-fg">{winner.nickname}</p>
                            {!rolling && (
                                <span className="rounded-full bg-success/15 px-2 py-0.5 text-[0.625rem] font-bold uppercase text-success">
                                    {t("people.winner")}
                                </span>
                            )}
                        </motion.div>
                    ) : (
                        <Gift className="size-8 text-fg-subtle" />
                    )}
                </AnimatePresence>
            </div>

            <Button
                variant="soft"
                onClick={draw}
                loading={rolling}
                disabled={eligible.length === 0}
                icon={<Sparkles />}
            >
                {rolling ? t("people.drawing") : winner ? t("people.drawAgain") : t("people.draw")}
            </Button>
        </Card>
    );
}
