# mariowOS - bridge to the Windows media session (System Media Transport Controls).
# Reads what any media app (Spotify desktop, browsers, ...) is playing and controls it,
# with no account or API: the same data Windows shows in its volume flyout.
#
# Protocol: one command per line on stdin, one JSON object per line on stdout.
#   get | toggle | play | pause | next | prev | seek <ms>
# Prefix a command with "any:" (e.g. "any:get") to target whatever Windows considers the
# current player instead of preferring Spotify.
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

Add-Type -AssemblyName System.Runtime.WindowsRuntime
$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
})[0]
function Await($operation, [Type]$resultType) {
    $task = $asTaskGeneric.MakeGenericMethod($resultType).Invoke($null, @($operation))
    $null = $task.Wait(5000)
    $task.Result
}

$null = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType = WindowsRuntime]
$null = [Windows.Storage.Streams.IInputStream, Windows.Storage.Streams, ContentType = WindowsRuntime]
$null = [Windows.Storage.Streams.IRandomAccessStreamWithContentType, Windows.Storage.Streams, ContentType = WindowsRuntime]
$asStreamForRead = [System.IO.WindowsRuntimeStreamExtensions].GetMethod('AsStreamForRead', [type[]]@([Windows.Storage.Streams.IInputStream]))
$manager = Await ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager])

$thumbCache = @{ key = $null; data = $null }
$script:anySession = $false

function Get-TargetSession {
    if ($script:anySession) { return $manager.GetCurrentSession() }
    $sessions = @($manager.GetSessions())
    # Prefer Spotify, then whatever Windows considers current.
    $spotify = $sessions | Where-Object { $_.SourceAppUserModelId -match 'Spotify' } | Select-Object -First 1
    if ($spotify) { return $spotify }
    return $manager.GetCurrentSession()
}

function Read-Thumbnail($props, $key) {
    if ($thumbCache.key -eq $key) { return $thumbCache.data }
    $data = $null
    try {
        if ($props.Thumbnail) {
            $stream = Await ($props.Thumbnail.OpenReadAsync()) ([Windows.Storage.Streams.IRandomAccessStreamWithContentType])
            # PowerShell cannot bind the WinRT stream to IInputStream directly; reflection can.
            $netStream = $asStreamForRead.Invoke($null, @($stream))
            $buffer = New-Object System.IO.MemoryStream
            $netStream.CopyTo($buffer)
            $netStream.Close()
            if ($buffer.Length -gt 0 -and $buffer.Length -lt 4MB) {
                $type = if ($stream.ContentType) { $stream.ContentType } else { 'image/jpeg' }
                $data = "data:$type;base64," + [Convert]::ToBase64String($buffer.ToArray())
            }
            try { $stream.Close() } catch {}
        }
    } catch { $data = $null }
    $thumbCache.key = $key
    $thumbCache.data = $data
    return $data
}

function Get-State {
    $session = Get-TargetSession
    if (-not $session) { return @{ ok = $true; session = $null } }
    $props = Await ($session.TryGetMediaPropertiesAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties])
    $playback = $session.GetPlaybackInfo()
    $timeline = $session.GetTimelineProperties()
    $key = "$($props.Artist)|$($props.Title)|$($props.AlbumTitle)"
    $position = $timeline.Position.TotalMilliseconds
    $isPlaying = [string]$playback.PlaybackStatus -eq 'Playing'
    # Position is a snapshot taken at LastUpdatedTime; advance it to "now" while playing.
    if ($isPlaying -and $timeline.LastUpdatedTime.Year -gt 2000) {
        $position += ([DateTimeOffset]::Now - $timeline.LastUpdatedTime).TotalMilliseconds
    }
    $duration = ($timeline.EndTime - $timeline.StartTime).TotalMilliseconds
    return @{
        ok = $true
        session = @{
            app = $session.SourceAppUserModelId
            title = $props.Title
            artist = $props.Artist
            album = $props.AlbumTitle
            isPlaying = $isPlaying
            positionMs = [math]::Max(0, [math]::Min($position, [math]::Max($duration, 0)))
            durationMs = [math]::Max(0, $duration)
            canSeek = $playback.Controls.IsPlaybackPositionEnabled
            image = (Read-Thumbnail $props $key)
        }
    }
}

function Invoke-Control($command, $argument) {
    $session = Get-TargetSession
    if (-not $session) { return @{ ok = $false; error = 'Nothing is playing.' } }
    $op = switch ($command) {
        'toggle' { $session.TryTogglePlayPauseAsync() }
        'play'   { $session.TryPlayAsync() }
        'pause'  { $session.TryPauseAsync() }
        'next'   { $session.TrySkipNextAsync() }
        'prev'   { $session.TrySkipPreviousAsync() }
        'seek'   { $session.TryChangePlaybackPositionAsync([int64]([double]$argument * 10000)) }
    }
    $done = Await $op ([bool])
    return @{ ok = [bool]$done }
}

while ($true) {
    $line = [Console]::In.ReadLine()
    if ($null -eq $line) { break }
    $text = $line.Trim()
    $script:anySession = $text.StartsWith('any:')
    if ($script:anySession) { $text = $text.Substring(4) }
    $parts = $text.Split(' ', 2)
    try {
        $result = if ($parts[0] -eq 'get') { Get-State } else { Invoke-Control $parts[0] $parts[1] }
    } catch {
        $result = @{ ok = $false; error = $_.Exception.Message }
    }
    [Console]::Out.WriteLine(($result | ConvertTo-Json -Compress -Depth 4))
    [Console]::Out.Flush()
}
