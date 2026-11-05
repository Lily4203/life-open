# Synthesize one line of text into a wav file using the built-in Windows voice.
# Kept ASCII-only on purpose: a .ps1 with non-ASCII characters gets mangled by
# whatever encoding the system happens to use. The TEXT arrives from a UTF-8 file.
param(
  [Parameter(Mandatory = $true)][string]$TextFile,
  [Parameter(Mandatory = $true)][string]$Out,
  [string]$Voice = ''
)

$ErrorActionPreference = 'Stop'
try {
  Add-Type -AssemblyName System.Speech
  $text = [System.IO.File]::ReadAllText($TextFile, [System.Text.Encoding]::UTF8)
  if ([string]::IsNullOrWhiteSpace($text)) { Write-Error 'empty text'; exit 2 }

  $synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
  if ($Voice) {
    try { $synth.SelectVoice($Voice) } catch { Write-Warning ("voice not found: " + $Voice) }
  }
  # 22.05 kHz mono 16-bit: plenty for a small speaker in a browser, and small files.
  $fmt = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(
    22050,
    [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen,
    [System.Speech.AudioFormat.AudioChannel]::Mono
  )
  $synth.SetOutputToWaveFile($Out, $fmt)
  $synth.Speak($text)
  $synth.Dispose()
  exit 0
} catch {
  Write-Error $_.Exception.Message
  exit 1
}
