import {
  classificationOptions,
  colors,
  formatDate,
  formatTime,
  recordingTransferLabel,
  type Detection,
  type Page,
  type Recording,
} from "@beehave/shared";
import { Feather } from "@expo/vector-icons";
import { useState } from "react";
import {
  Alert,
  Pressable,
  RefreshControl,
  ScrollView,
  Share,
  Text,
  View,
} from "react-native";
import { API_BASE_URL, getSessionToken } from "../api";
import { CalendarSheet } from "../components/CalendarSheet";
import { DetectionRow } from "../components/DetectionRow";
import { SelectionSheet } from "../components/SelectionSheet";
import { Button, Card, Message, Pair } from "../components/FormControls";
import { useFarm } from "../farm";
import { useRemote } from "../hooks/useRemote";
import { Detail } from "../navigation";
import { styles } from "../styles";

export function Records({
  audio,
  date,
  setDate,
  station,
  expired,
  open,
}: {
  audio: boolean;
  date: string;
  setDate: (d: string) => void;
  station: string;
  expired: () => void;
  open: (d: Detail) => void;
}) {
  const { farmPath } = useFarm();
  const [page, setPage] = useState(1);
  const [oldest, setOldest] = useState(false);
  const [species, setSpecies] = useState("");
  const [calendarOpen, setCalendarOpen] = useState(false);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const query = useRemote<Page<Detection | Recording>>(
    farmPath(`/${audio ? "recordings" : "detections"}?from=${date}&to=${date}&page=${page}&order=${oldest ? "oldest" : "newest"}&device=${station}&species=${encodeURIComponent(species)}`),
    expired,
  );
  return (
    <ScrollView
      contentContainerStyle={styles.content}
      refreshControl={
        <RefreshControl refreshing={query.loading} onRefresh={query.reload} />
      }
    >
      <View style={styles.heading}>
        <Text style={styles.eyebrow}>
          {audio ? "RECORDING LIBRARY" : "MONITORING RECORDS"}
        </Text>
        <Text style={styles.title}>{audio ? "Audio" : "Detections"}</Text>
      </View>
      <View style={styles.toolbar}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Choose record date"
          style={[styles.stationSelector, styles.grow]}
          onPress={() => setCalendarOpen(true)}
        >
          <Feather name="calendar" size={17} color={colors.slate} />
          <Text style={styles.stationLabel}>{formatDate(date)}</Text>
          <Feather name="chevron-down" size={15} color={colors.slate} />
        </Pressable>
        <Pressable
          style={styles.iconButton}
          accessibilityRole="button"
          accessibilityLabel={
            oldest ? "Sort newest first" : "Sort oldest first"
          }
          onPress={() => {
            setOldest(!oldest);
            setPage(1);
          }}
        >
          <Feather
            name={oldest ? "arrow-up" : "arrow-down"}
            size={20}
            color={colors.navy}
          />
        </Pressable>
        {!audio && (
          <Pressable
            style={styles.iconButton}
            accessibilityRole="button"
            accessibilityLabel="Filter classification"
            onPress={() => setFiltersOpen(true)}
          >
            <Feather
              name="sliders"
              size={19}
              color={species ? colors.amber : colors.navy}
            />
          </Pressable>
        )}
      </View>
      <CalendarSheet
        visible={calendarOpen}
        date={date}
        onSelect={(value) => {
          setDate(value);
          setPage(1);
        }}
        onClose={() => setCalendarOpen(false)}
      />
      <SelectionSheet
        title="Classification"
        visible={filtersOpen}
        selected={species}
        options={classificationOptions}
        onSelect={(value) => {
          setSpecies(value);
          setPage(1);
        }}
        onClose={() => setFiltersOpen(false)}
      />
      {query.error && <Message>{query.error}</Message>}
      {query.data && (
        <>
          <Card>
            {query.data.items.length ? (
              query.data.items.map((v) =>
                audio ? (
                  <Pressable
                    key={v.id}
                    style={styles.record}
                    onPress={() =>
                      open({ kind: "recording", device: v.deviceId, id: v.id })
                    }
                  >
                    <View style={styles.row}>
                      <Feather
                        name="headphones"
                        size={20}
                        color={colors.blue}
                      />
                      <Text style={styles.subtitle}>
                        {(v as Recording).duration}s · WAV
                      </Text>
                      <Feather
                        name="chevron-right"
                        size={18}
                        color={colors.slate}
                      />
                    </View>
                    <Text style={styles.caption}>
                      {(v as Recording).filename}
                    </Text>
                    <Pair
                      label={formatTime(v.observedAt)}
                      value={recordingTransferLabel(v as Recording)}
                    />
                  </Pressable>
                ) : (
                  <DetectionRow key={v.id} d={v as Detection} open={open} />
                ),
              )
            ) : (
              <Text style={styles.muted}>
                No {audio ? "recordings" : "detections"} for this date.
              </Text>
            )}
          </Card>
          <Text style={styles.caption}>
            {query.data.total} records · Page {page} of {query.data.pages}
          </Text>
          {query.data.pages > 1 && (
            <View style={styles.row}>
              <Button
                title="Previous"
                disabled={page <= 1}
                onPress={() => setPage(page - 1)}
              />
              <Button
                title="Next"
                disabled={page >= query.data.pages}
                onPress={() => setPage(page + 1)}
              />
            </View>
          )}
          {!audio && query.data.total > 0 && (
            <Button
              title="Export detections as CSV"
              onPress={async () => {
                try {
                  const result = await fetch(
                    `${API_BASE_URL}${farmPath(`/api/export?from=${date}&to=${date}&device=${station}&species=${encodeURIComponent(species)}`)}`,
                    {
                      headers: { Authorization: `Bearer ${getSessionToken()}` },
                    },
                  );
                  if (!result.ok)
                    throw new Error(
                      "Export failed. Narrow the date range or sign in again.",
                    );
                  await Share.share({
                    message: await result.text(),
                    title: "BeeHave detections CSV",
                  });
                } catch (e) {
                  Alert.alert("Export failed", (e as Error).message);
                }
              }}
            />
          )}
        </>
      )}
    </ScrollView>
  );
}
