{{/*
Common Labels
*/}}
{{- define "digital-marketplace.labels" -}}
app.kubernetes.io/name: {{ .Values.name }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}
