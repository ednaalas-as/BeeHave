import {
  ago,
  colors,
  formatDate,
  formatHourWindow,
  formatMeasurement,
  isOnline,
  manilaDate,
  type Summary,
} from "@beehave/shared";
import {
  chartMetricOrder,
  chartMetrics,
  chartSeries,
  resolutionText,
  type ChartMetric,
} from "@beehave/shared/chart-series";
import { Feather } from "@expo/vector-icons";
import { useEffect, useState } from "react";
import {
  Pressable,
  RefreshControl,
  ScrollView,
  Text,
  useWindowDimensions,
  View,
} from "react-native";
import { ActivityChart } from "../components/ActivityChart";
import { DetectionRow } from "../components/DetectionRow";
import { Card, Message } from "../components/FormControls";
import { PeriodControl } from "../components/PeriodControl";
import { useFarm } from "../farm";
import { useRemote } from "../hooks/useRemote";
import { Detail } from "../navigation";
import { styles } from "../styles";

export function Overview({
  historical,
  sample,
  station,
  expired,
  open,
  selectDate,
  openDevices,
}: {
  historical: boolean;
  sample: boolean;
  station: string;
  expired: () => void;
  open: (detail: Detail) => void;
  selectDate: (date: string) => void;
  openDevices: () => void;
}) {
  const [metrics, setMetrics] = useState<{
    dashboard: ChartMetric;
    activity: ChartMetric;
  }>({ dashboard: "count", activity: "count" });
  const metricKey = historical ? "activity" : "dashboard";
  const metric = metrics[metricKey];
  const [days, setDays] = useState(historical || sample ? 7 : 1);
  const { farmPath } = useFarm();
  useEffect(() => setDays(historical || sample ? 7 : 1), [historical, sample]);
  const from = manilaDate(new Date(Date.now() - (days - 1) * 86400000));
  const query = useRemote<Summary>(
    farmPath(`/summary?from=${from}&to=${manilaDate()}&device=${station}`),
    expired,
  );
  const summary = query.data;
  const latestReading = summary?.recent.find(
    (detection) => detection.reading,
  )?.reading;
  // The API sizes buckets to the range: hourly today, daily for a week or month.
  const chart = summary && chartSeries(summary, metric);
  const reporting = summary?.devices.filter(isOnline).length ?? 0;
  // Environment and station status share one lane: side by side on wide screens, stacked on phones.
  const wide = useWindowDimensions().width >= 600;
  const stationStatus = summary && (
    <Pressable
      style={[styles.deviceStrip, wide && styles.grow]}
      accessibilityRole="button"
      onPress={openDevices}
    >
      <Feather name="cpu" size={20} color={colors.slate} />
      <View style={styles.grow}>
        <Text style={styles.recordTitle}>Station status</Text>
        <Text style={styles.caption}>
          {reporting} of {summary.devices.length} reporting recently
        </Text>
      </View>
      <Feather name="chevron-right" size={18} color={colors.slate} />
    </Pressable>
  );

  return (
    <ScrollView
      contentContainerStyle={styles.content}
      refreshControl={
        <RefreshControl
          tintColor={colors.amber}
          refreshing={query.loading}
          onRefresh={query.reload}
        />
      }
    >
      <View style={styles.row}>
        <View style={styles.heading}>
          <Text style={styles.eyebrow}>
            {historical ? "HISTORY" : "MONITORING"}
          </Text>
          <Text style={styles.title}>
            {historical ? "Activity" : "Overview"}
          </Text>
        </View>
        <Text style={styles.caption}>{formatDate(manilaDate())}</Text>
      </View>
      <PeriodControl days={days} onChange={setDays} historical={historical} />
      {query.error && <Message>{query.error}</Message>}
      {summary && (
        <>
          {!summary.devices.length && (
            <Message>
              No station connected yet. Open Devices to register your Raspberry
              Pi.
            </Message>
          )}
          <View style={styles.hero}>
            <View style={styles.row}>
              <Text style={styles.heroLabel}>T. biroi detections</Text>
              <Text style={styles.heroBadge}>
                {days === 1 ? "TODAY" : days === 365 ? "LAST YEAR" : `LAST ${days} DAYS`}
              </Text>
            </View>
            <View>
              <Text style={styles.heroValue}>
                {summary.total.toLocaleString()}
              </Text>
              <Text style={styles.heroCaption}>
                {summary.previousTotal.toLocaleString()} in the previous{" "}
                {days === 1 ? "day" : days === 365 ? "year" : `${days}-day period`}
              </Text>
            </View>
            <View style={styles.heroDivider} />
            <View style={styles.row}>
              <View style={styles.heroStat}>
                <Text style={styles.heroCaption}>Mean acoustic frequency</Text>
                <Text style={styles.heroStatValue}>
                  {summary.total ? summary.averageFrequency.toFixed(1) : "—"}{" "}
                  <Text style={styles.heroUnit}>Hz</Text>
                </Text>
              </View>
              <View style={styles.heroStat}>
                <Text style={styles.heroCaption}>Peak activity</Text>
                <Text style={styles.heroStatValue}>
                  {summary.peakHour ? `${summary.peakHour}:00` : "—"}{" "}
                  <Text style={styles.heroUnit}>PHT</Text>
                </Text>
              </View>
            </View>
            <View style={styles.row}>
              <View style={styles.heroStat}>
                <Text style={styles.heroCaption}>Visitation frequency</Text>
                <Text style={styles.heroStatValue}>
                  {summary.visitationFrequency == null
                    ? "—"
                    : summary.visitationFrequency.toFixed(1)}{" "}
                  <Text style={styles.heroUnit}>/ hr</Text>
                </Text>
              </View>
              <View style={styles.heroStat}>
                <Text style={styles.heroCaption}>Peak visitation</Text>
                <Text style={styles.heroStatValue}>
                  {summary.peakVisitation
                    ? summary.peakVisitation.count.toLocaleString()
                    : "—"}{" "}
                  <Text style={styles.heroUnit}>/ hr</Text>
                </Text>
                {summary.peakVisitation && (
                  <Text style={styles.heroCaption}>
                    {formatHourWindow(summary.peakVisitation.start, days > 1)}
                  </Text>
                )}
              </View>
            </View>
          </View>
          {!historical && (
            <View style={[styles.lane, wide && styles.laneWide]}>
              <View style={[{ gap: 8 }, wide && styles.grow]}>
                <View style={styles.metricGrid}>
                  <View style={styles.metric}>
                    <View style={styles.row}>
                      <Text style={styles.label}>Temperature</Text>
                      <View style={styles.metricIcon}>
                        <Feather name="thermometer" size={15} color="#BE892F" />
                      </View>
                    </View>
                    <Text style={styles.metricValue}>
                      {latestReading?.temperature == null ? "—" : formatMeasurement(latestReading.temperature)}
                      <Text style={styles.muted}> °C</Text>
                    </Text>
                  </View>
                  <View style={styles.metric}>
                    <View style={styles.row}>
                      <Text style={styles.label}>Humidity</Text>
                      <View style={[styles.metricIcon, styles.metricIconBlue]}>
                        <Feather name="droplet" size={15} color={colors.blue} />
                      </View>
                    </View>
                    <Text style={styles.metricValue}>
                      {latestReading?.humidity == null ? "—" : formatMeasurement(latestReading.humidity)}
                      <Text style={styles.muted}> %</Text>
                    </Text>
                  </View>
                </View>
                <Text style={styles.caption}>
                  {latestReading
                    ? `Latest linked reading · ${ago(latestReading.observedAt)}`
                    : "No linked sensor reading in this period"}
                </Text>
              </View>
              {stationStatus}
            </View>
          )}
          <Card>
            <View style={styles.chartHeader}>
              <Text style={styles.subtitle}>
                {chartMetrics[metric].title}{" "}
                {chart?.resolution === "hour" ? "by hour" : "over time"}
              </Text>
              <View style={styles.chartLegend}>
                <View style={styles.dot} />
                <Text style={styles.caption}>{chartMetrics[metric].legend}</Text>
              </View>
            </View>
            {chart && (
              <ActivityChart
                values={chart.values}
                labels={chart.labels}
                periods={chart.periods}
                metric={metric}
              />
            )}
            <View
              accessibilityRole="radiogroup"
              accessibilityLabel="Graph measurement"
              style={{ flexDirection: "row", flexWrap: "wrap" }}
            >
              {chartMetricOrder.map((value) => (
                <Pressable
                  key={value}
                  accessibilityRole="radio"
                  accessibilityLabel={chartMetrics[value].label}
                  accessibilityState={{ checked: metric === value }}
                  onPress={() =>
                    setMetrics((current) => ({
                      ...current,
                      [metricKey]: value,
                    }))
                  }
                  // Two per row, so the series form a readable grid on narrow phones.
                  style={{
                    flexDirection: "row",
                    alignItems: "center",
                    gap: 6,
                    minHeight: 44,
                    width: "50%",
                  }}
                >
                  <View
                    style={{
                      width: 16,
                      height: 16,
                      borderRadius: 8,
                      borderWidth: 1,
                      borderColor: colors.blue,
                      alignItems: "center",
                      justifyContent: "center",
                    }}
                  >
                    {metric === value && (
                      <View
                        style={{
                          width: 8,
                          height: 8,
                          borderRadius: 4,
                          backgroundColor: colors.blue,
                        }}
                      />
                    )}
                  </View>
                  <Text style={styles.caption}>{chartMetrics[value].short}</Text>
                </Pressable>
              ))}
            </View>
            <Text style={styles.caption}>
              {chart ? `Per ${resolutionText[chart.resolution]} · ` : ""}Asia/Manila · Tap
              the graph for values · Acoustic events, not unique bees
            </Text>
          </Card>
          {historical ? (
            <Card>
              <Text style={styles.subtitle}>Daily summaries</Text>
              {[...summary.daily].reverse().map((day) => (
                <Pressable
                  key={day.date}
                  style={styles.record}
                  accessibilityRole="button"
                  accessibilityLabel={`View detections for ${day.date}`}
                  onPress={() => selectDate(day.date)}
                >
                  <View style={styles.row}>
                    <Text style={styles.recordTitle}>
                      {formatDate(day.date)}
                    </Text>
                    <Text style={styles.blue}>
                      {day.count.toLocaleString()}
                    </Text>
                  </View>
                  <Text style={styles.caption}>
                    {day.count ? `${day.frequency.toFixed(1)} Hz` : "No events"}{" "}
                    · {day.temperature == null ? "—" : formatMeasurement(day.temperature)} °C ·{" "}
                    {day.humidity == null ? "—" : formatMeasurement(day.humidity)}% humidity
                  </Text>
                </Pressable>
              ))}
            </Card>
          ) : (
            <Card>
              <View style={styles.row}>
                <Text style={styles.subtitle}>Recent detections</Text>
                <Pressable
                  style={styles.textButton}
                  accessibilityRole="button"
                  onPress={() =>
                    selectDate(
                      summary.recent[0]
                        ? manilaDate(new Date(summary.recent[0].observedAt))
                        : manilaDate(),
                    )
                  }
                >
                  <Text style={styles.link}>View all</Text>
                </Pressable>
              </View>
              {summary.recent.length ? (
                summary.recent
                  .slice(0, 3)
                  .map((detection) => (
                    <DetectionRow
                      key={detection.id}
                      d={detection}
                      open={open}
                    />
                  ))
              ) : (
                <View style={styles.empty}>
                  <Feather name="radio" size={28} color={colors.slate} />
                  <Text style={styles.muted}>
                    No detections in this period.
                  </Text>
                </View>
              )}
            </Card>
          )}
          {historical && stationStatus}
        </>
      )}
    </ScrollView>
  );
}
