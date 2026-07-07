import { Checkbox } from "@base-ui/react/checkbox";
import { Check, ChevronDown, ChevronRight, FolderTree, Search } from "lucide-react";
import { useMemo, useState } from "react";
import type { OwnerGroup, RepositorySummary } from "../services/githubItems";
import type { UseProjectVisibilityResult } from "../hooks/useProjectVisibility";
import "./ui/form-controls.css";

interface ProjectsVisibilitySectionProps {
  groups: OwnerGroup[];
  visibility: UseProjectVisibilityResult;
}

function sourceLabel(repository: RepositorySummary): string {
  const sources: string[] = [];
  if (repository.participating) {
    sources.push("참여");
  }
  if (repository.watched) {
    sources.push("구독");
  }
  if (repository.orgMember) {
    sources.push("조직");
  }
  return sources.join(" · ");
}

function OwnerCheckbox({
  group,
  visibility
}: {
  group: OwnerGroup;
  visibility: UseProjectVisibilityResult;
}) {
  const visibleCount = group.repositories.filter(visibility.isVisible).length;
  const allVisible = visibleCount === group.repositories.length;
  const indeterminate = visibleCount > 0 && !allVisible;

  return (
    <Checkbox.Root
      className="settings-check project-owner-check"
      render={<label />}
      aria-label={`Show ${group.owner} projects`}
      checked={allVisible && group.repositories.length > 0}
      indeterminate={indeterminate}
      onCheckedChange={(next) => visibility.setOwnerVisible(group, next)}
    >
      <span className="ui-checkbox" aria-hidden="true">
        <Checkbox.Indicator className="ui-checkbox-indicator">
          <Check size={12} strokeWidth={3} />
        </Checkbox.Indicator>
      </span>
      <span>{group.owner}</span>
    </Checkbox.Root>
  );
}

export function ProjectsVisibilitySection({
  groups,
  visibility
}: ProjectsVisibilitySectionProps) {
  const [query, setQuery] = useState("");
  // Explicit expand/collapse choices; unset owners fall back to the default
  // (open only when at least one repository is selected for the sidebar).
  const [expandedOwners, setExpandedOwners] = useState<Record<string, boolean>>({});
  const searching = query.trim().length > 0;

  const filteredGroups = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) {
      return groups;
    }
    return groups
      .map((group) => ({
        ...group,
        repositories: group.owner.toLowerCase().includes(normalized)
          ? group.repositories
          : group.repositories.filter((repository) =>
              repository.fullName.toLowerCase().includes(normalized)
            )
      }))
      .filter((group) => group.repositories.length > 0);
  }, [groups, query]);

  function isGroupExpanded(group: OwnerGroup): boolean {
    if (searching) {
      return true;
    }
    return (
      expandedOwners[group.owner] ??
      group.repositories.some((repository) => visibility.isVisible(repository))
    );
  }

  function toggleGroup(group: OwnerGroup) {
    const expanded = isGroupExpanded(group);
    setExpandedOwners((current) => ({ ...current, [group.owner]: !expanded }));
  }

  function keepOpen(owner: string) {
    setExpandedOwners((current) => ({ ...current, [owner]: true }));
  }

  return (
    <section className="settings-section" aria-label="Project visibility">
      <div className="settings-section-title">
        <FolderTree size={18} />
        <h3>Projects 표시</h3>
      </div>
      <p className="server-editor-help">
        첫 번째 컬럼의 Projects 구역에 표시할 owner 그룹과 저장소를 선택하세요.
        참여(소유/협업)·구독 중이거나 내 활동이 있는 저장소는 기본으로 표시되고,
        조직 소속으로만 접근 가능한 저장소는 체크해야 표시됩니다.
      </p>
      {groups.length === 0 ? (
        <p className="empty-copy">표시할 저장소가 없습니다. 먼저 로그인하세요.</p>
      ) : (
        <div className="project-visibility-search">
          <Search size={15} />
          <input
            aria-label="Filter projects"
            placeholder="owner 또는 저장소 검색"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
      )}
      {groups.length > 0 && filteredGroups.length === 0 && (
        <p className="empty-copy">검색과 일치하는 저장소가 없습니다.</p>
      )}
      <div className="project-visibility-list">
        {filteredGroups.map((group) => {
          const expanded = isGroupExpanded(group);
          return (
            <div className="project-visibility-group" key={group.owner}>
              <div className="project-owner-row">
                <button
                  type="button"
                  className="project-group-toggle"
                  aria-label={`Toggle ${group.owner} projects`}
                  aria-expanded={expanded}
                  onClick={() => toggleGroup(group)}
                >
                  {expanded ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
                </button>
                <OwnerCheckbox group={group} visibility={visibility} />
                <span className="project-owner-count">
                  {group.repositories.filter(visibility.isVisible).length}/
                  {group.repositories.length}
                </span>
              </div>
              {expanded &&
                group.repositories.map((repository) => (
                  <Checkbox.Root
                    key={repository.fullName}
                    className="settings-check project-repo-check"
                    render={<label />}
                    aria-label={`Show ${repository.fullName}`}
                    checked={visibility.isVisible(repository)}
                    onCheckedChange={(next) => {
                      keepOpen(group.owner);
                      visibility.setRepositoryVisible(repository.fullName, next);
                    }}
                  >
                    <span className="ui-checkbox" aria-hidden="true">
                      <Checkbox.Indicator className="ui-checkbox-indicator">
                        <Check size={12} strokeWidth={3} />
                      </Checkbox.Indicator>
                    </span>
                    <span>
                      {repository.name}
                      <em className="project-repo-source">{sourceLabel(repository)}</em>
                    </span>
                  </Checkbox.Root>
                ))}
            </div>
          );
        })}
      </div>
    </section>
  );
}
