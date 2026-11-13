import { phoneHelpTopics } from "./phoneHelp.js";

export function PhoneHelp() {
  return (
    <div id="phone-help" className="settings-row space-y-4 px-5 py-4">
      {phoneHelpTopics.map((topic) => (
        <div key={topic.title}>
          <h3 className="text-balance text-[14.5px] font-medium text-neutral-50">{topic.title}</h3>
          <ul className="mt-1.5 list-disc space-y-1 pl-5 text-pretty text-[13px] leading-5 text-[#8a8a8a]">
            {topic.steps.map((step) => (
              <li key={step}>{step}</li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}
