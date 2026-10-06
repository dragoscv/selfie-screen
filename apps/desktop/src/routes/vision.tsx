import { Activity, Crosshair, History, Users, Workflow } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { CalibrationTab } from "../components/vision/calibration-tab.js";
import { Tabs } from "../components/vision/fields.js";
import { LogTab } from "../components/vision/log-tab.js";
import { PeopleTab } from "../components/vision/people-tab.js";
import { RulesTab } from "../components/vision/rules-tab.js";
import { SignalsTab } from "../components/vision/signals-tab.js";
import { usePushVisionToStudio } from "../lib/vision/use-vision.js";

const TABS = ["rules", "signals", "log", "people", "calibration"] as const;
type TabId = (typeof TABS)[number];
const ICONS = { rules: Workflow, signals: Activity, log: History, people: Users, calibration: Crosshair } as const;

/** Main-window Vision route: rules (list + graph), signals, log, people & pets, calibration. */
export function VisionRoute() {
    const { t } = useTranslation();
    const [tab, setTab] = useState<TabId>("rules");
    usePushVisionToStudio();

    return (
        <div className="flex h-full min-h-0 flex-col">
            <Tabs
                label={t("vision.title")}
                tabs={TABS}
                value={tab}
                onChange={setTab}
                idPrefix="vision"
                display={(id) => {
                    const Icon = ICONS[id];
                    return (
                        <>
                            <Icon className="size-3.5" aria-hidden />
                            {t(`vision.tabs.${id}`)}
                        </>
                    );
                }}
            />
            <div
                role="tabpanel"
                id={`vision-panel-${tab}`}
                aria-labelledby={`vision-tab-${tab}`}
                tabIndex={0}
                className="min-h-0 flex-1 overflow-y-auto outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
            >
                <div className="measure-wide mx-auto flex flex-col gap-5 px-6 py-6">
                    {tab === "rules" && <RulesTab />}
                    {tab === "signals" && <SignalsTab />}
                    {tab === "log" && <LogTab />}
                    {tab === "people" && <PeopleTab />}
                    {tab === "calibration" && <CalibrationTab />}
                </div>
            </div>
        </div>
    );
}
