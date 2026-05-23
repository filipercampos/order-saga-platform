{{- define "saga.name" -}}
{{- default (printf "%s-service" .Values.service) .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "saga.labels" -}}
app.kubernetes.io/name: {{ include "saga.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/part-of: order-saga-platform
app.kubernetes.io/version: {{ .Values.image.tag | default .Chart.AppVersion | quote }}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version }}
{{- end -}}

{{- define "saga.selectorLabels" -}}
app.kubernetes.io/name: {{ include "saga.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{- define "saga.image" -}}
{{- required "image.tag is required (git sha)" .Values.image.tag | printf "%s:%s" .Values.image.repository -}}
{{- end -}}

{{- define "saga.env" -}}
- name: SERVICE
  value: {{ .Values.service | quote }}
- name: PORT
  value: {{ .Values.containerPort | quote }}
- name: NODE_ENV
  value: production
- name: OTEL_SERVICE_NAME
  value: {{ include "saga.name" . }}
{{- if .Values.observability.collectorSidecar.enabled }}
- name: OTEL_EXPORTER_OTLP_ENDPOINT
  value: http://127.0.0.1:4318
{{- else }}
- name: HOST_IP
  valueFrom:
    fieldRef:
      fieldPath: status.hostIP
- name: OTEL_EXPORTER_OTLP_ENDPOINT
  value: http://$(HOST_IP):4318
{{- end }}
{{- range $key, $value := .Values.env }}
- name: {{ $key }}
  value: {{ $value | quote }}
{{- end }}
{{- end -}}

{{- define "saga.serviceAccount" -}}
{{- default (include "saga.name" .) .Values.serviceAccount.name -}}
{{- end -}}
