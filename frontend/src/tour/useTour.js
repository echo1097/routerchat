import { useMemo, useState } from "react";
import { TOUR_STEPS } from "./tourSteps.js";

const desktopBreakpoint = 1024;

function isDesktopViewport() {
  if (typeof window === "undefined") return true;
  return window.innerWidth >= desktopBreakpoint;
}


export function useTour() {
  const [stepIndex, setStepIndex] = useState(-1);
  const isActive = stepIndex >= 0;

  const steps = useMemo(() => {
    const desktop = isDesktopViewport();
    return TOUR_STEPS.filter((step) => !step.desktopOnly || desktop);
   
  }, [isActive]);

  const currentStep = isActive ? steps[stepIndex] : null;
  const isLastStep = isActive && stepIndex === steps.length - 1;

  function start() {
    setStepIndex(0);
  }

  function next() {
    setStepIndex((current) => Math.min(current + 1, steps.length - 1));
  }

  function previous() {
    setStepIndex((current) => Math.max(current - 1, 0));
  }

  function finish() {
    setStepIndex(-1);
  }

  return {
    isActive,
    currentStep,
    stepIndex,
    stepCount: steps.length,
    isLastStep,
    start,
    next,
    previous,
    finish,
  };
}
