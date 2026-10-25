import {
type Page,
type Recording,
formatDate,
recordingTransferLabel,
formatTime,
} from "@beehave/shared";
import { useQuery } from "@tanstack/react-query";
import { ArrowUpRight,AudioLines,Clock3,Info } from "lucide-react";
import { Link } from "react-router-dom";
import { api,queryString,useWorkspace } from "../api";
import { Filters,useRecordFilters } from "../components/RecordFilters";
import { Badge,Empty,Failure,Loading,PageHeading,Pagination } from "../ui";

export function Recordings() {
  const { farm, device, refresh } = useWorkspace();
  const f = useRecordFilters();
  // The farm is part of the request and its cache key, so another farm's page never shows.
  const params = queryString({
    farm: farm.id,
    device,
    from: f.from,
    to: f.to,
    order: f.order,
    page: f.page,
  });
  const query = useQuery({
    queryKey: ["recordings", params],
    queryFn: () => api<Page<Recording>>(`/recordings?${params}`),
    refetchInterval: refresh ? refresh * 1000 : false,
  });
  return (
    <>
      <PageHeading
        eyebrow="RECORDINGS"
        title="Audio recordings"
        description="The sound behind each observation. Preserved for monitoring and research."
      />
      <Filters f={f} />
      {query.isPending ? (
        <Loading />
      ) : query.isError ? (
        <Failure error={query.error} retry={() => query.refetch()} />
      ) : (
        <section className="card">
          {query.data.items.length ? (
            <div className="recording-list">
              {query.data.items.map((recording) => (
                <Link
                  className="recording-row"
                  key={recording.id}
                  to={`/recordings/${recording.deviceId}/${recording.id}`}
                >
                  <span className="recording-icon">
                    <AudioLines size={24} />
                  </span>
                  <div className="recording-name">
                    <strong>{recording.filename}</strong>
                    <small>
                      {formatDate(recording.observedAt)} ·{" "}
                      {formatTime(recording.observedAt)}
                    </small>
                  </div>
                  <span className="recording-duration">
                    <Clock3 size={14} />
                    {recording.duration}s · WAV
                  </span>
                  <Badge
                    tone={recording.status === "available" ? "green" : "amber"}
                  >
                    {recordingTransferLabel(recording)}
                  </Badge>
                  <ArrowUpRight size={17} />
                </Link>
              ))}
            </div>
          ) : (
            <Empty
              title="No recordings in this period"
              text="Audio evidence will appear as your edge device synchronizes."
            />
          )}
          <Pagination
            page={f.page}
            pages={query.data.pages}
            total={query.data.total}
            onChange={(p) => f.update("page", String(p))}
          />
        </section>
      )}
      <div className="insight-note">
        <Info size={16} />
        Recordings are part of the monitoring record and cannot be deleted from
        the app.
      </div>
    </>
  );
}
