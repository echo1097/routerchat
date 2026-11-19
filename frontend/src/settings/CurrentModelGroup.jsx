import { SettingGroup } from "./SettingControls.jsx";

export function CurrentModelGroup({ id, name, children }) {
  return (
    <div className="mb-4 shrink-0">
      <SettingGroup id={id} title="Current model" evenSpacing>
        <div className="settings-row flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-5 py-4">
          <h3 className="min-w-0 truncate text-[15px] font-semibold tracking-[-0.01em] text-neutral-50" title={name}>
            {name}
          </h3>
          {children && <div className="flex flex-wrap items-center justify-end gap-1.5">{children}</div>}
        </div>
      </SettingGroup>
    </div>
  );
}
