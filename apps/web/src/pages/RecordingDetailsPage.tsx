import { type Recording, formatDate, formatTime, recordingTransferLabel } from "@beehave/shared";
import { useQuery } from "@tanstack/react-query";
import { ArrowUpRight, AudioLines, Download, Radio } from "lucide-react";
import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api, useWorkspace } from "../api";
import { PlaybackAudio } from "../components/PlaybackAudio";
import { DetailShell, Failure, Loading, PageHeading, useDetectionLink } from "../ui";

export function RecordingDetail() {
  const { deviceId, id } = useParams();
  const { farm, farmPath } = useWorkspace();
  const detailLink = useDetectionLink();
  const [error, setError] = useState(false);
  // Only a recording of the selected farm opens; any other ID answers "not found".
  const query = useQuery({
    queryKey: ["recording", farm.id, deviceId, id],
    queryFn: () => api<Recording>(farmPath(`/recordings/${deviceId}/${id}`)),
    refetchInterval: 30000,
  });
  if (query.isPending) return <Loading />;
  if (query.isError)
    return <Failure error={query.error} retry={() => query.refetch()} />;
  const recording = query.data;
  const audio = `/api/recordings/${deviceId}/${id}/audio`;
  const url = farmPath(audio);
  return (
    <>
      <PageHeading
        eyebrow="AUDIO EVIDENCE"
        title="Recording detail"
        description={`${formatDate(recording.observedAt)} · ${formatTime(recording.observedAt)} · Asia/Manila`}
      />
      <DetailShell title={recording.filename} back="/recordings">
        <div className="audio-player">
          <span className="large-audio-icon">
            <AudioLines size={44} />
          </span>
          <h2>{recording.duration}-second recording</h2>
          <p className="muted">
            WAV audio ·{" "}
            {recording.synthetic
              ? "Synthetic demonstration tone"
              : "Captured by the source device"}
          </p>
          {recording.status === "available" ? (
            <>
              <PlaybackAudio
                key={url}
                src={url}
                onError={() => setError(true)}
                label={`Play ${recording.filename}`}
              />
              {error && (
                <p className="form-error" role="alert">
                  Audio could not be played. The file may be unavailable or
                  unsupported.
                </p>
              )}
              <a className="button" href={farmPath(`${audio}?download=1`)} download>
                <Download size={16} /> Download recording
              </a>
            </>
          ) : (
            <div className="notice">
              {recording.status === "pending"
                ? `Audio: ${recordingTransferLabel(recording).toLowerCase()}.`
                : "The audio file is unavailable."}{" "}
              Associated detections remain accessible.
            </div>
          )}
        </div>
        <div className="detail-section">
          <h3>Linked detections</h3>
          {recording.detectionIds.length ? (
            recording.detectionIds.map((id) => (
              <Link
                key={id}
                className="recording-link"
                to={detailLink(recording.deviceId, id)}
              >
                <Radio size={19} />
                <span>Detection #{id}</span>
                <ArrowUpRight size={17} />
              </Link>
            ))
          ) : (
            <p className="muted">No detection metadata has been linked yet.</p>
          )}
        </div>
        <div className="detail-section">
          <span className="small-label">SOURCE DEVICE</span>
          <p className="mono">{recording.deviceId}</p>
        </div>
      </DetailShell>
    </>
  );
}
