import {
  classificationLabel,
  colors,
  formatDate,
  formatMeasurement,
  formatTime,
  recordingTransferLabel,
  type Detection,
  type Recording,
} from "@beehave/shared";
import { ActivityIndicator, ScrollView, Text } from "react-native";
import { Player } from "../components/AudioPlayer";
import { Button, Card, Message, Pair } from "../components/FormControls";
import { useFarm } from "../farm";
import { useRemote } from "../hooks/useRemote";
import { Detail } from "../navigation";
import { styles } from "../styles";

export function Details({
  detail,
  open,
  close,
  expired,
}: {
  detail: NonNullable<Detail>;
  open: (d: Detail) => void;
  close: () => void;
  expired: () => void;
}) {
  const { farmPath } = useFarm();
  const query = useRemote<Detection | Recording>(
    farmPath(`/${detail.kind === "detection" ? "detections" : "recordings"}/${detail.device}/${detail.id}`),
    expired,
  );
  const value = query.data;
  return (
    <ScrollView contentContainerStyle={styles.content}>
      <Button title="Back to records" onPress={close} />
      <Text style={styles.title}>
        {detail.kind === "detection" ? "Detection detail" : "Recording detail"}
      </Text>
      {query.loading && <ActivityIndicator color={colors.amber} />}
      {query.error && <Message>{query.error}</Message>}
      {value && (
        <>
          <Text style={styles.caption}>
            {formatDate(value.observedAt)} · {formatTime(value.observedAt)}
          </Text>
          {detail.kind === "detection" ? (
            <DetectionInfo d={value as Detection} open={open} />
          ) : (
            <>
              <Card>
                <Text style={styles.subtitle}>
                  {(value as Recording).filename}
                </Text>
                <Pair label="Status" value={recordingTransferLabel(value as Recording)} />
                {(value as Recording).status === "available" ? (
                  <Player key={detail.id} recording={value as Recording} />
                ) : (
                  <Message>
                    Audio is awaiting upload or unavailable. Associated
                    detections remain accessible.
                  </Message>
                )}
              </Card>
              <Card>
                <Text style={styles.subtitle}>Linked detections</Text>
                {(value as Recording).detectionIds?.map((id) => (
                  <Button
                    key={id}
                    title={`Detection #${id}`}
                    onPress={() =>
                      open({ kind: "detection", device: value.deviceId, id })
                    }
                  />
                ))}
              </Card>
            </>
          )}
        </>
      )}
    </ScrollView>
  );
}

export function DetectionInfo({
  d: detection,
  open,
}: {
  d: Detection;
  open: (d: Detail) => void;
}) {
  return (
    <>
      <Card>
        <Pair label="Classification" value={classificationLabel(detection.species)} />
        <Pair label="Acoustic frequency" value={`${detection.frequency} Hz`} />
        <Pair
          label="Confidence"
          value={`${(detection.confidence * 100).toFixed(1)}%`}
        />
        <Text style={styles.caption}>Model: {detection.modelVersion}</Text>
        <Text style={styles.caption}>Device: {detection.deviceId}</Text>
      </Card>
      <Card>
        <Text style={styles.subtitle}>Environmental context</Text>
        {detection.reading ? (
          <>
            <Pair
              label="Temperature"
              value={`${detection.reading.temperature === null ? "—" : formatMeasurement(detection.reading.temperature)} °C`}
            />
            <Pair
              label="Humidity"
              value={`${detection.reading.humidity === null ? "—" : formatMeasurement(detection.reading.humidity)} %`}
            />
            <Text style={styles.caption}>
              Sensor timestamp: {formatDate(detection.reading.observedAt)} ·{" "}
              {formatTime(detection.reading.observedAt)}
            </Text>
          </>
        ) : (
          <Text style={styles.muted}>No associated valid sensor reading.</Text>
        )}
        <Text style={styles.caption}>
          Environmental values do not contribute to model confidence.
        </Text>
      </Card>
      {detection.recording &&
        detection.audioWindow &&
        detection.recording.status === "available" && (
          <Card>
            <Player
              key={detection.id}
              recording={detection.recording}
              source={{
                path: `/api/detections/${detection.deviceId}/${detection.id}/audio`,
                duration: 3,
              }}
            />
          </Card>
        )}
      {detection.recording ? (
        <Button
          title="Open associated recording"
          onPress={() =>
            open({
              kind: "recording",
              device: detection.deviceId,
              id: detection.recording!.id,
            })
          }
        />
      ) : (
        <Message>Recording metadata is absent or not yet synchronized.</Message>
      )}
    </>
  );
}
