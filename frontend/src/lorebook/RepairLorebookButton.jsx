import React, { useState } from "react";
import { cx, CONTROL_MOTION } from "../uiShared.js";
import RepairModal, { repairDurationParts } from "./RepairModal.jsx";

//repair timeline but for the whole book: the visible lorebook gets thrown out and written again from the chapters
export default function RepairLorebookButton({ locked, saving, onRepair }) {
  const [repairOpen, setRepairOpen] = useState(false);
  const [repairStage, setRepairStage] = useState("confirm");
  const [repairPhase, setRepairPhase] = useState("thinking");
  const [repairReasoning, setRepairReasoning] = useState("");
  const [repairDurationMs, setRepairDurationMs] = useState(null);
  const [repairedCount, setRepairedCount] = useState(0);
  const [repairError, setRepairError] = useState("");

  function openRepair() {
    if (locked || saving) return;

    setRepairStage("confirm");
    setRepairPhase("thinking");
    setRepairReasoning("");
    setRepairDurationMs(null);
    setRepairedCount(0);
    setRepairError("");
    setRepairOpen(true);
  }

  function closeRepair() {
    if (repairStage === "running") return;
    setRepairOpen(false);
  }

  async function confirmRepair() {
    if (repairStage === "running") return;

    setRepairStage("running");
    setRepairPhase("thinking");
    setRepairReasoning("");
    setRepairError("");

    try {
      const result = await onRepair((event) => {
        //the backend flips to writing the moment the first entry lands
        if (event.type === "status") {
          if (event.value === "writing") setRepairPhase("writing");
          return;
        }
        if (event.type !== "reasoning" || !event.value) return;
        setRepairReasoning((currentReasoning) => `${currentReasoning}${event.value}`);
      });

      setRepairedCount(Number(result.entry_count) || 0);
      setRepairDurationMs(result.duration_ms);
      setRepairStage("complete");
    } catch (error) {
      setRepairError(error.message || "Could not rebuild lorebook.");
      setRepairStage("error");
    }
  }

  const { seconds: durationSeconds, unit: durationUnit } = repairDurationParts(repairDurationMs);
  const entryUnit = repairedCount === 1 ? "entry" : "entries";

  return (
    <>
      <button
        type="button"
        onClick={openRepair}
        disabled={locked || saving}
        className={cx("lorebook-primary-button", CONTROL_MOTION)}
      >
        Repair lorebook
      </button>

      <RepairModal
        open={repairOpen}
        stage={repairStage}
        phase={repairPhase}
        reasoning={repairReasoning}
        error={repairError}
        idPrefix="lorebook-repair"
        closeLabel="Close lorebook repair"
        titles={{
          confirm: "Repair lorebook?",
          complete: "Lorebook rebuilt",
          error: "Lorebook repair failed",
        }}
        confirmLabel="Repair lorebook"
        description={
          <>
            Repair lorebook deletes every entry in the lorebook, including the timeline, and writes
            a new one from the entire story (every chapter not hidden from context). The old
            lorebook is only used as a hint about what to track. Entries you have hidden from
            context are left alone, and chapter summaries are not rebuilt. Do you want to continue?
          </>
        }
        runningLabel={{
          thinking: "Repairing lorebook, thinking",
          writing: "Repairing lorebook, writing the rebuilt lorebook",
        }}
        completeMessage={
          <>
            Rebuilt <span className="lorebook-repair-duration">{repairedCount}</span> {entryUnit} in{" "}
            <span className="lorebook-repair-duration">{durationSeconds}</span> {durationUnit}.
          </>
        }
        errorLead="Could not rebuild lorebook. The current lorebook was not changed."
        reasoningTestId="lorebook-repair-reasoning"
        onConfirm={confirmRepair}
        onClose={closeRepair}
      />
    </>
  );
}
