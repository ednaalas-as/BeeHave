import {
  type Detection,
  formatDate,
  formatMeasurement,
  formatTime,
  BEE_LABEL,
  NON_BEE_CLASSIFICATION,
  NON_BEE_LABEL,
  classificationLabel,
} from "@beehave/shared";
import { useQuery } from "@tanstack/react-query";
import { ArrowUpRight } from "lucide-react";
import { type ReactNode } from "react";
import { Link, Navigate, useParams, useSearchParams } from "react-router-dom";
import { api, useWorkspace } from "../api";
import { Modal } from "../components/Modal";
import { PlaybackAudio } from "../components/PlaybackAudio";
import { Badge, detailParams, Failure, Loading } from "../ui";

/** Old full-page links open the same detection in the modal over the records list. */
export function DetectionDetail() {
  const { deviceId = "", id = "" } = useParams();
  const search = new URLSearchParams({ [detailParams.device]: deviceId, [detailParams.id]: id });
  return <Navigate to={`/detections?${search}`} replace />;
}

/** Renders the detection modal whenever the URL names one, on any page. */
export function DetectionModalHost() {
  const [search, setSearch] = useSearchParams();
  const deviceId = search.get(detailParams.device);
  const id = search.get(detailParams.id);
  if (!deviceId || !id) return null;
  const close = () => {
    const next = new URLSearchParams(search);
    next.delete(detailParams.device);
    next.delete(detailParams.id);
    setSearch(next);
  };
  return <DetectionModal key={`${deviceId}/${id}`} deviceId={deviceId} id={id} onClose={close} />;
}

function Value({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <span className="caption">{label}</span>
      <strong>{children}</strong>
    </div>
  );
}

function DetectionModal({ deviceId, id, onClose }: { deviceId: string; id: string; onClose: () => void }) {
  const { farm, farmPath } = useWorkspace();
  const query = useQuery({
    queryKey: ["detection", farm.id, deviceId, id],
    queryFn: () => api<Detection>(farmPath(`/detections/${deviceId}/${id}`)),
  });
  const detection = query.data;
  const bee = detection && detection.species !== NON_BEE_CLASSIFICATION;
  const reading = detection?.reading;
  const playable =
    detection?.recording && detection.audioWindow && detection.recording.status === "available";
  return (
    <Modal
      title="Detection details"
      description={
        detection
          ? `${formatDate(detection.observedAt)} at ${formatTime(detection.observedAt)} · Asia/Manila`
          : undefined
      }
      onClose={onClose}
    >
      {query.isPending ? (
        <Loading />
      ) : query.isError ? (
        <Failure error={query.error} retry={() => query.refetch()} />
      ) : (
        detection && (
          <div className="detection-modal">
            <section className="detection-section">
              <h3 className="small-label">CLASSIFICATION</h3>
              <div className="detection-classification">
                <div className="detection-status">
                  <Badge tone={bee ? "green" : "gray"}>{bee ? BEE_LABEL : NON_BEE_LABEL}</Badge>
                  {bee && classificationLabel(detection.species) !== BEE_LABEL && <span>{detection.species}</span>}
                </div>
                <div className="detection-confidence">
                  <strong>{(detection.confidence * 100).toFixed(1)}%</strong>
                  <span className="caption">confidence</span>
                </div>
              </div>
              <p className="caption">
                Confidence is the model's score for this classification, not a measure of accuracy.
              </p>
            </section>
            <section className="detection-section">
              <h3 className="small-label">3-SECOND DETECTION CLIP</h3>
              <div className="detection-audio">
                {playable ? (
                  <PlaybackAudio
                    src={farmPath(`/api/detections/${detection.deviceId}/${detection.id}/audio`)}
                    label="Play the 3-second detection clip"
                  />
                ) : (
                  <p className="muted">
                    {!detection.recordingId
                      ? "No recording was attached to this detection."
                      : !detection.recording
                        ? "The recording has not synchronized yet."
                        : detection.recording.status !== "available"
                          ? "The audio is awaiting synchronization."
                          : "This detection's clip position is not known; the full recording is still available."}
                  </p>
                )}
                {detection.recording && (
                  <Link
                    className="text-link"
                    to={`/recordings/${detection.deviceId}/${detection.recording.id}`}
                  >
                    Open full recording ({detection.recording.duration} s) <ArrowUpRight size={14} />
                  </Link>
                )}
              </div>
            </section>
            <section className="detection-section">
              <h3 className="small-label">MEASUREMENTS</h3>
              <div className="detection-values">
                <Value label="Acoustic frequency">{detection.frequency.toFixed(1)} Hz</Value>
                <Value label="Temperature">
                  {reading?.temperature == null ? "—" : `${formatMeasurement(reading.temperature)} °C`}
                </Value>
                <Value label="Humidity">
                  {reading?.humidity == null ? "—" : `${formatMeasurement(reading.humidity)} %`}
                </Value>
              </div>
              <p className="caption">
                {reading
                  ? `Sensor reading taken ${formatDate(reading.observedAt)} at ${formatTime(reading.observedAt)}.`
                  : "No sensor reading is associated with this detection."}
              </p>
            </section>
            <section className="detection-section">
              <h3 className="small-label">TECHNICAL DETAILS</h3>
              <dl className="technical-details">
                <div><dt>Detection ID</dt><dd className="mono">{detection.id}</dd></div>
                <div><dt>Device ID</dt><dd className="mono">{detection.deviceId}</dd></div>
                <div><dt>Model version</dt><dd className="mono">{detection.modelVersion}</dd></div>
                {detection.recording && (
                  <div><dt>Recording file</dt><dd className="mono">{detection.recording.filename}</dd></div>
                )}
              </dl>
            </section>
          </div>
        )
      )}
    </Modal>
  );
}
