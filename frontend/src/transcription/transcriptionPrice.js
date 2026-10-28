import { priceLabel } from "../modelFormatting.js";

const hourlyPriceFloor = 0.01;
const secondsPerHour = 3600;


function formatHourly(dollars) {
  if (dollars >= 0.1) return `$${dollars.toFixed(2)}`;
  return `$${Number(dollars.toPrecision(2))}`;
}


export function transcriptionPrice(model) {
  const prompt = Number(model?.pricing?.prompt);
  const completion = Number(model?.pricing?.completion || 0);
  if (!Number.isFinite(prompt) || !Number.isFinite(completion) || prompt <= 0 || completion < 0) return null;

  if (completion > 0) {
    return {
      label: `${priceLabel(model)} per M`,
      title: "Per million input and output tokens",
    };
  }

  const perHour = prompt >= hourlyPriceFloor ? prompt : prompt * secondsPerHour;
  return {
    label: `${formatHourly(perHour)} / hr`,
    title: "Per hour of audio",
  };
}
