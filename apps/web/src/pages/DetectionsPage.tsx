import { type Detection,type Page } from "@beehave/shared";
import { useQuery } from "@tanstack/react-query";
import { Download } from "lucide-react";
import { useState } from "react";
import { api,queryString,useWorkspace } from "../api";
import { Filters,useRecordFilters } from "../components/RecordFilters";
import {
DetectionTable,
Failure,
Loading,
PageHeading,
Pagination,
} from "../ui";

export function Detections() {
  const { farm, device, refresh } = useWorkspace();
  const f = useRecordFilters();
  // The farm is part of the request and its cache key, so another farm's page never shows.
  const params = queryString({
    farm: farm.id,
    device,
    from: f.from,
    to: f.to,
    order: f.order,
    species: f.species,
    page: f.page,
    size: f.size,
  });
  const query = useQuery({
    queryKey: ["detections", params],
    queryFn: () => api<Page<Detection>>(`/detections?${params}`),
    refetchInterval: refresh ? refresh * 1000 : false,
  });
  const [exportError, setExportError] = useState("");
  async function download() {
    setExportError("");
    try {
      const response = await fetch(`/api/export?${params}`);
      if (!response.ok) {
        const e = await response.json();
        throw new Error(e.error);
      }
      const url = URL.createObjectURL(await response.blob());
      const downloadLink = document.createElement("a");
      downloadLink.href = url;
      downloadLink.download = "beehave-detections.csv";
      downloadLink.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) {
      setExportError((e as Error).message);
    }
  }
  return (
    <>
      <PageHeading
        eyebrow="DETECTIONS"
        title="Detection records"
        description="Inspect acoustic classifications and their original environmental context."
        actions={
          <button onClick={download}>
            <Download size={16} /> Export CSV
          </button>
        }
      />
      <Filters f={f} classification />
      {exportError && (
        <p className="form-error" role="alert">
          {exportError}
        </p>
      )}
      {query.isPending ? (
        <Loading />
      ) : query.isError ? (
        <Failure error={query.error} retry={() => query.refetch()} />
      ) : (
        <section className="card">
          <DetectionTable items={query.data.items} />
          <Pagination
            page={f.page}
            pages={query.data.pages}
            total={query.data.total}
            onChange={(p) => f.update("page", String(p))}
            pageSize={f.size}
            onPageSizeChange={(size) => f.update("size", String(size))}
          />
        </section>
      )}
    </>
  );
}
