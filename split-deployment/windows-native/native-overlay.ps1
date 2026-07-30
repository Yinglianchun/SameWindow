[CmdletBinding()]
param(
    [int]$ChromePid = 0,
    [string]$ProfilePath = "",
    [string]$ControlUrl = "http://127.0.0.1:6081",
    [string]$CursorStateFile = "",
    [switch]$ValidateOnly
)

$ErrorActionPreference = "Stop"

Add-Type -AssemblyName PresentationFramework
Add-Type -AssemblyName PresentationCore
Add-Type -AssemblyName WindowsBase
Add-Type -AssemblyName System.Net.Http
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

$nativeSource = @'
using System;
using System.Runtime.InteropServices;
using System.Text;

public static class SameWindowOverlayNative
{
    public const int GWL_EXSTYLE = -20;
    public const long WS_EX_TRANSPARENT = 0x00000020L;
    public const long WS_EX_TOOLWINDOW = 0x00000080L;
    public const long WS_EX_NOACTIVATE = 0x08000000L;
    public const uint SWP_NOACTIVATE = 0x0010;
    public const uint SWP_SHOWWINDOW = 0x0040;
    public const uint GA_ROOT = 2;

    public delegate bool EnumWindowProc(IntPtr hwnd, IntPtr lParam);

    [StructLayout(LayoutKind.Sequential)]
    public struct RECT
    {
        public int Left;
        public int Top;
        public int Right;
        public int Bottom;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct POINT
    {
        public int X;
        public int Y;
    }

    [DllImport("user32.dll")]
    public static extern bool EnumWindows(EnumWindowProc callback, IntPtr lParam);

    [DllImport("user32.dll")]
    public static extern bool EnumChildWindows(IntPtr parent, EnumWindowProc callback, IntPtr lParam);

    [DllImport("user32.dll")]
    public static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint processId);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    public static extern int GetClassName(IntPtr hwnd, StringBuilder className, int maxCount);

    [DllImport("user32.dll")]
    public static extern bool IsWindowVisible(IntPtr hwnd);

    [DllImport("user32.dll")]
    public static extern bool IsIconic(IntPtr hwnd);

    [DllImport("user32.dll")]
    public static extern bool GetWindowRect(IntPtr hwnd, out RECT rect);

    [DllImport("user32.dll")]
    public static extern bool GetClientRect(IntPtr hwnd, out RECT rect);

    [DllImport("user32.dll")]
    public static extern bool ClientToScreen(IntPtr hwnd, ref POINT point);

    [DllImport("user32.dll")]
    public static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll")]
    public static extern IntPtr GetAncestor(IntPtr hwnd, uint flags);

    [DllImport("user32.dll")]
    public static extern bool GetCursorPos(out POINT point);

    [DllImport("user32.dll")]
    public static extern short GetAsyncKeyState(int key);

    [DllImport("user32.dll")]
    public static extern uint GetDpiForWindow(IntPtr hwnd);

    [DllImport("user32.dll", EntryPoint = "GetWindowLongPtr")]
    private static extern IntPtr GetWindowLongPtr64(IntPtr hwnd, int index);

    [DllImport("user32.dll", EntryPoint = "GetWindowLong")]
    private static extern IntPtr GetWindowLongPtr32(IntPtr hwnd, int index);

    [DllImport("user32.dll", EntryPoint = "SetWindowLongPtr")]
    private static extern IntPtr SetWindowLongPtr64(IntPtr hwnd, int index, IntPtr value);

    [DllImport("user32.dll", EntryPoint = "SetWindowLong")]
    private static extern IntPtr SetWindowLongPtr32(IntPtr hwnd, int index, IntPtr value);

    [DllImport("user32.dll")]
    public static extern bool SetWindowPos(
        IntPtr hwnd,
        IntPtr insertAfter,
        int x,
        int y,
        int width,
        int height,
        uint flags
    );

    private static IntPtr GetWindowLongPtr(IntPtr hwnd, int index)
    {
        return IntPtr.Size == 8
            ? GetWindowLongPtr64(hwnd, index)
            : GetWindowLongPtr32(hwnd, index);
    }

    private static void SetWindowLongPtr(IntPtr hwnd, int index, IntPtr value)
    {
        if (IntPtr.Size == 8) SetWindowLongPtr64(hwnd, index, value);
        else SetWindowLongPtr32(hwnd, index, value);
    }

    private static string WindowClass(IntPtr hwnd)
    {
        var value = new StringBuilder(256);
        GetClassName(hwnd, value, value.Capacity);
        return value.ToString();
    }

    private static long Area(RECT rect)
    {
        return Math.Max(0, rect.Right - rect.Left) * (long)Math.Max(0, rect.Bottom - rect.Top);
    }

    public static IntPtr FindChromeWindow(int processId)
    {
        IntPtr best = IntPtr.Zero;
        long bestArea = 0;
        EnumWindows((hwnd, _) =>
        {
            uint candidateProcessId;
            RECT rect;
            GetWindowThreadProcessId(hwnd, out candidateProcessId);
            if (candidateProcessId != processId || !IsWindowVisible(hwnd)) return true;
            if (WindowClass(hwnd) != "Chrome_WidgetWin_1") return true;
            if (!GetWindowRect(hwnd, out rect)) return true;
            long area = Area(rect);
            if (area > bestArea)
            {
                best = hwnd;
                bestArea = area;
            }
            return true;
        }, IntPtr.Zero);
        return best;
    }

    public static bool TryGetChromeContentRect(int processId, out IntPtr root, out RECT content)
    {
        root = FindChromeWindow(processId);
        content = new RECT();
        if (root == IntPtr.Zero || IsIconic(root)) return false;
        RECT windowRect;
        if (!GetWindowRect(root, out windowRect)) return false;
        uint dpi = GetDpiForWindow(root);
        if (dpi == 0) dpi = 96;
        int toolbarInset = (int)Math.Round(86.0 * dpi / 96.0);
        int minimumContentTop = windowRect.Top + toolbarInset;

        RECT best = new RECT();
        long bestArea = 0;
        EnumChildWindows(root, (hwnd, _) =>
        {
            RECT rect;
            if (!IsWindowVisible(hwnd) || WindowClass(hwnd) != "Chrome_RenderWidgetHostHWND") return true;
            if (!GetWindowRect(hwnd, out rect)) return true;
            long area = Area(rect);
            if (area > bestArea)
            {
                best = rect;
                bestArea = area;
            }
            return true;
        }, IntPtr.Zero);

        if (bestArea > 100000)
        {
            // Some Chrome builds expose a renderer host spanning the complete
            // Aura window. Never let that pull the overlay into the tab strip.
            best.Top = Math.Max(best.Top, minimumContentTop);
            content = best;
            return true;
        }

        RECT client;
        if (!GetClientRect(root, out client)) return false;
        POINT origin = new POINT { X = client.Left, Y = client.Top };
        if (!ClientToScreen(root, ref origin)) return false;
        content = new RECT
        {
            Left = origin.X,
            Top = origin.Y + toolbarInset,
            Right = origin.X + Math.Max(1, client.Right - client.Left),
            Bottom = origin.Y + Math.Max(toolbarInset + 1, client.Bottom - client.Top),
        };
        return Area(content) > 100000;
    }

    public static bool ChromeIsForeground(IntPtr root)
    {
        if (root == IntPtr.Zero) return false;
        IntPtr foreground = GetForegroundWindow();
        return foreground == root || GetAncestor(foreground, GA_ROOT) == root;
    }

    public static void ConfigureOverlayWindow(IntPtr hwnd, bool clickThrough)
    {
        long styles = GetWindowLongPtr(hwnd, GWL_EXSTYLE).ToInt64();
        styles |= WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE;
        if (clickThrough) styles |= WS_EX_TRANSPARENT;
        SetWindowLongPtr(hwnd, GWL_EXSTYLE, new IntPtr(styles));
    }
}
'@

Add-Type -TypeDefinition $nativeSource

if ($ValidateOnly) {
    Write-Output "native overlay syntax and assemblies are valid"
    exit 0
}

if (-not $CursorStateFile) {
    throw "CursorStateFile is required."
}

function Test-DedicatedChromePid {
    param([int]$CandidatePid)

    if ($CandidatePid -le 0 -or -not $ProfilePath) {
        return $false
    }
    $normalizedProfile = [IO.Path]::GetFullPath($ProfilePath)
    $candidate = Get-CimInstance Win32_Process -Filter "ProcessId = $CandidatePid" -ErrorAction SilentlyContinue
    return $null -ne $candidate -and
        $candidate.Name -ieq "chrome.exe" -and
        $candidate.CommandLine -and
        $candidate.CommandLine -notmatch '\s--type=' -and
        $candidate.CommandLine.IndexOf($normalizedProfile, [StringComparison]::OrdinalIgnoreCase) -ge 0
}

function Resolve-ChromePid {
    if (Test-DedicatedChromePid $script:resolvedPid) {
        return $script:resolvedPid
    }
    if (Test-DedicatedChromePid $ChromePid) {
        return $ChromePid
    }
    if (-not $ProfilePath) {
        return 0
    }
    $normalizedProfile = [IO.Path]::GetFullPath($ProfilePath)
    $candidate = Get-CimInstance Win32_Process -Filter "Name = 'chrome.exe'" |
        Where-Object {
            $_.CommandLine -and
            $_.CommandLine -notmatch '\s--type=' -and
            $_.CommandLine.IndexOf($normalizedProfile, [StringComparison]::OrdinalIgnoreCase) -ge 0
        } |
        Select-Object -First 1
    if ($candidate) {
        return [int]$candidate.ProcessId
    }
    return 0
}

$script:resolvedPid = Resolve-ChromePid
$script:nextChromeProbeAt = [DateTime]::MinValue

$cursorWindow = New-Object Windows.Window
$cursorWindow.WindowStyle = [Windows.WindowStyle]::None
$cursorWindow.ResizeMode = [Windows.ResizeMode]::NoResize
$cursorWindow.AllowsTransparency = $true
$cursorWindow.Background = [Windows.Media.Brushes]::Transparent
$cursorWindow.ShowInTaskbar = $false
$cursorWindow.ShowActivated = $false
$cursorWindow.Topmost = $true
$cursorWindow.Focusable = $false

$cursorCanvas = New-Object Windows.Controls.Canvas
$cursorCanvas.Background = [Windows.Media.Brushes]::Transparent
$cursorWindow.Content = $cursorCanvas

$cursorGeometry = [Windows.Media.Geometry]::Parse(
    "M 4.6,3.2 C 3.6,2.55 2.35,3.35 2.55,4.55 L 5.65,28.4 " +
    "C 5.82,29.7 7.42,30.18 8.25,29.18 L 13.05,23.45 L 17.35,32.2 " +
    "C 17.82,33.18 19.02,33.55 19.95,33.02 L 24.18,30.6 " +
    "C 25.13,30.05 25.43,28.82 24.85,27.9 L 19.65,19.58 L 27.18,18.25 " +
    "C 28.48,18.02 28.83,16.33 27.72,15.62 Z"
)

$cursorOutline = New-Object Windows.Shapes.Path
$cursorOutline.Data = $cursorGeometry
$cursorOutline.Fill = [Windows.Media.Brushes]::Black
$cursorOutline.Stroke = [Windows.Media.Brushes]::Black
$cursorOutline.StrokeThickness = 5.4
$cursorOutline.StrokeLineJoin = [Windows.Media.PenLineJoin]::Round

$cursorInner = New-Object Windows.Shapes.Path
$cursorInner.Data = $cursorGeometry
$cursorInner.Fill = [Windows.Media.Brushes]::Black
$cursorInner.Stroke = [Windows.Media.Brushes]::White
$cursorInner.StrokeThickness = 2.45
$cursorInner.StrokeLineJoin = [Windows.Media.PenLineJoin]::Round

$cursorVisual = New-Object Windows.Controls.Grid
$cursorVisual.Width = 32
$cursorVisual.Height = 36
$cursorVisual.Children.Add($cursorOutline) | Out-Null
$cursorVisual.Children.Add($cursorInner) | Out-Null
$cursorVisual.Visibility = [Windows.Visibility]::Collapsed
$cursorVisual.Effect = New-Object Windows.Media.Effects.DropShadowEffect -Property @{
    BlurRadius = 12
    Color = [Windows.Media.ColorConverter]::ConvertFromString("#339CFF")
    Opacity = 0.9
    ShadowDepth = 0
}

$cursorRotate = New-Object Windows.Media.RotateTransform
$cursorRotate.CenterX = 5
$cursorRotate.CenterY = 5
$cursorTranslate = New-Object Windows.Media.TranslateTransform
$cursorTransforms = New-Object Windows.Media.TransformGroup
$cursorTransforms.Children.Add($cursorRotate)
$cursorTransforms.Children.Add($cursorTranslate)
$cursorVisual.RenderTransform = $cursorTransforms
$cursorCanvas.Children.Add($cursorVisual) | Out-Null

$clickRing = New-Object Windows.Shapes.Ellipse
$clickRing.Width = 22
$clickRing.Height = 22
$clickRing.Stroke = [Windows.Media.SolidColorBrush]::new(
    [Windows.Media.ColorConverter]::ConvertFromString("#E0339CFF")
)
$clickRing.StrokeThickness = 2
$clickRing.Opacity = 0
$ringScale = New-Object Windows.Media.ScaleTransform
$ringScale.CenterX = 11
$ringScale.CenterY = 11
$clickRing.RenderTransform = $ringScale
$cursorCanvas.Children.Add($clickRing) | Out-Null

$watchWindow = New-Object Windows.Window
$watchWindow.WindowStyle = [Windows.WindowStyle]::None
$watchWindow.ResizeMode = [Windows.ResizeMode]::NoResize
$watchWindow.AllowsTransparency = $true
$watchWindow.Background = [Windows.Media.Brushes]::Transparent
$watchWindow.ShowInTaskbar = $false
$watchWindow.ShowActivated = $false
$watchWindow.Topmost = $true
$watchWindow.Focusable = $false
$watchWindow.Cursor = [Windows.Input.Cursors]::Hand

$watchBorder = New-Object Windows.Controls.Border
$watchBorder.CornerRadius = [Windows.CornerRadius]::new(16)
$watchBorder.BorderThickness = [Windows.Thickness]::new(1)
$watchBorder.BorderBrush = [Windows.Media.Brushes]::Transparent
$watchBorder.Background = [Windows.Media.Brushes]::Transparent
$watchBorder.Padding = [Windows.Thickness]::new(6, 0, 6, 0)

$watchStack = New-Object Windows.Controls.StackPanel
$watchStack.Orientation = [Windows.Controls.Orientation]::Horizontal
$watchStack.VerticalAlignment = [Windows.VerticalAlignment]::Center

$watchIcon = New-Object Windows.Controls.Canvas
$watchIcon.Width = 25
$watchIcon.Height = 18
$watchIcon.VerticalAlignment = [Windows.VerticalAlignment]::Center

$watchCursorFar = New-Object Windows.Shapes.Path
$watchCursorFar.Data = $cursorGeometry
$watchCursorFar.Fill = [Windows.Media.SolidColorBrush]::new(
    [Windows.Media.ColorConverter]::ConvertFromString("#17191B")
)
$watchCursorFar.Stroke = [Windows.Media.Brushes]::White
$watchCursorFar.StrokeThickness = 2.2
$watchCursorFar.StrokeLineJoin = [Windows.Media.PenLineJoin]::Round
$watchCursorFarTransform = New-Object Windows.Media.TransformGroup
$watchCursorFarTransform.Children.Add([Windows.Media.ScaleTransform]::new(0.39, 0.39))
$watchCursorFarTransform.Children.Add([Windows.Media.TranslateTransform]::new(0, 1))
$watchCursorFar.RenderTransform = $watchCursorFarTransform

$watchCursorNear = New-Object Windows.Shapes.Path
$watchCursorNear.Data = $cursorGeometry
$watchCursorNear.Fill = [Windows.Media.SolidColorBrush]::new(
    [Windows.Media.ColorConverter]::ConvertFromString("#A7ADB0")
)
$watchCursorNear.Stroke = [Windows.Media.Brushes]::White
$watchCursorNear.StrokeThickness = 2.2
$watchCursorNear.StrokeLineJoin = [Windows.Media.PenLineJoin]::Round
$watchCursorNearTransform = New-Object Windows.Media.TransformGroup
$watchCursorNearTransform.Children.Add([Windows.Media.ScaleTransform]::new(0.39, 0.39))
$watchCursorNearTransform.Children.Add([Windows.Media.TranslateTransform]::new(10, 3))
$watchCursorNear.RenderTransform = $watchCursorNearTransform

$watchIcon.Children.Add($watchCursorFar) | Out-Null
$watchIcon.Children.Add($watchCursorNear) | Out-Null

$watchLabel = New-Object Windows.Controls.TextBlock
$watchText = "$([char]0x4E00)$([char]0x8D77)$([char]0x901B)"
$watchLabel.Text = $watchText
$watchLabel.Margin = [Windows.Thickness]::new(6, 0, 0, 0)
$watchLabel.VerticalAlignment = [Windows.VerticalAlignment]::Center
$watchLabel.FontFamily = [Windows.Media.FontFamily]::new("Segoe UI")
$watchLabel.FontWeight = [Windows.FontWeights]::SemiBold
$watchLabel.FontSize = 13
$watchLabel.Foreground = [Windows.Media.SolidColorBrush]::new(
    [Windows.Media.ColorConverter]::ConvertFromString("#17191B")
)
$watchLabel.Visibility = [Windows.Visibility]::Collapsed

$watchStack.Children.Add($watchIcon) | Out-Null
$watchStack.Children.Add($watchLabel) | Out-Null
$watchBorder.Child = $watchStack
$watchWindow.Content = $watchBorder
$watchWindow.ToolTip = $watchText

$cursorHandle = [Windows.Interop.WindowInteropHelper]::new($cursorWindow).EnsureHandle()
$watchHandle = [Windows.Interop.WindowInteropHelper]::new($watchWindow).EnsureHandle()
[SameWindowOverlayNative]::ConfigureOverlayWindow($cursorHandle, $true)
[SameWindowOverlayNative]::ConfigureOverlayWindow($watchHandle, $false)

$webClient = New-Object Net.WebClient
$webClient.Headers[[Net.HttpRequestHeader]::ContentType] = "application/json"

$watchEnabled = $false
$watchExpanded = $false
$lastWatchRefresh = [DateTime]::MinValue
$lastCursorWrite = [DateTime]::MinValue
$lastCursorSequence = ""
$lastCursorCommand = $null
$lastPointerSignature = ""
$lastCursorTargetX = 0.0
$lastCursorTargetY = 0.0
$cursorWindowVisible = $false
$watchWindowVisible = $false
$lastContentSignature = ""
$lastTabSignature = ""
$lastTabSync = [DateTime]::MinValue
$lastTabProbe = [DateTime]::MinValue
$pendingTabSignature = ""
$pendingTabSince = [DateTime]::MinValue
$lastGeometryRefresh = [DateTime]::MinValue
$currentGeometry = $null

$tabItemCondition = [Windows.Automation.PropertyCondition]::new(
    [Windows.Automation.AutomationElement]::ControlTypeProperty,
    [Windows.Automation.ControlType]::TabItem
)
$editCondition = [Windows.Automation.PropertyCondition]::new(
    [Windows.Automation.AutomationElement]::ControlTypeProperty,
    [Windows.Automation.ControlType]::Edit
)

function Get-ActiveChromeTab([IntPtr]$rootHandle) {
    try {
        $automationRoot = [Windows.Automation.AutomationElement]::FromHandle($rootHandle)
        $tabs = $automationRoot.FindAll(
            [Windows.Automation.TreeScope]::Descendants,
            $tabItemCondition
        )
        $selectedTitle = ""
        $selectedIndex = -1
        for ($index = 0; $index -lt $tabs.Count; $index++) {
            $tab = $tabs.Item($index)
            try {
                $selection = $tab.GetCurrentPattern(
                    [Windows.Automation.SelectionItemPattern]::Pattern
                )
                if ($selection.Current.IsSelected) {
                    $selectedTitle = $tab.Current.Name
                    $selectedIndex = $index
                    break
                }
            } catch {
            }
        }
        if (-not $selectedTitle) {
            return $null
        }

        $address = ""
        $edits = $automationRoot.FindAll(
            [Windows.Automation.TreeScope]::Descendants,
            $editCondition
        )
        for ($index = 0; $index -lt $edits.Count; $index++) {
            $edit = $edits.Item($index)
            if ($edit.Current.ClassName -ne "OmniboxViewViews") {
                continue
            }
            try {
                $value = $edit.GetCurrentPattern([Windows.Automation.ValuePattern]::Pattern)
                $address = $value.Current.Value
            } catch {
            }
            break
        }
        return @{
            title = $selectedTitle
            address = $address
            index = $selectedIndex
        }
    } catch {
        return $null
    }
}

function Sync-ObservedTab([IntPtr]$rootHandle) {
    $tab = Get-ActiveChromeTab $rootHandle
    if (-not $tab) {
        return
    }
    $signature = "$($tab.title)`n$($tab.address)`n$($tab.index)"
    if ($signature -ne $script:pendingTabSignature) {
        $script:pendingTabSignature = $signature
        $script:pendingTabSince = [DateTime]::UtcNow
        return
    }
    if (
        $signature -ne $script:lastTabSignature -and
        ([DateTime]::UtcNow - $script:pendingTabSince).TotalMilliseconds -lt 160
    ) {
        return
    }
    if (
        $signature -eq $script:lastTabSignature -and
        ([DateTime]::UtcNow - $script:lastTabSync).TotalMilliseconds -lt 700
    ) {
        return
    }
    try {
        $payload = $tab | ConvertTo-Json -Compress
        $result = $webClient.UploadString(
            "$ControlUrl/browser/observed-tab",
            "POST",
            $payload
        ) | ConvertFrom-Json
        if ($result.ok) {
            $script:lastTabSignature = $signature
            $script:lastTabSync = [DateTime]::UtcNow
            $script:currentGeometry = $result.geometry
        }
    } catch {
    }
}

function Refresh-PageGeometry {
    try {
        $result = $webClient.DownloadString("$ControlUrl/browser/geometry") | ConvertFrom-Json
        if ($result.ok) {
            $script:currentGeometry = $result.geometry
        }
    } catch {
    }
}

function Geometry-ToRect($geometry, $windowRect) {
    if (
        -not $geometry -or
        -not $windowRect -or
        [double]$geometry.innerWidth -le 0 -or
        [double]$geometry.innerHeight -le 0
    ) {
        return $null
    }
    $windowWidth = [Math]::Max(1, $windowRect.Right - $windowRect.Left)
    $windowHeight = [Math]::Max(1, $windowRect.Bottom - $windowRect.Top)
    $sideInset = [Math]::Max(
        0,
        ($windowWidth - [double]$geometry.innerWidth) / 2
    )
    $topInset = [Math]::Max(
        0,
        $windowHeight - [double]$geometry.innerHeight - $sideInset
    )
    $rect = New-Object SameWindowOverlayNative+RECT
    $rect.Left = [int][Math]::Round($windowRect.Left + $sideInset)
    $rect.Top = [int][Math]::Round($windowRect.Top + $topInset)
    $rect.Right = $rect.Left + [int][Math]::Round([double]$geometry.innerWidth)
    $rect.Bottom = $rect.Top + [int][Math]::Round([double]$geometry.innerHeight)
    return $rect
}

function Set-WatchAppearance {
    if ($watchEnabled) {
        $watchCursorNear.Fill = [Windows.Media.SolidColorBrush]::new(
            [Windows.Media.ColorConverter]::ConvertFromString("#36AEB7")
        )
    } else {
        $watchCursorNear.Fill = [Windows.Media.SolidColorBrush]::new(
            [Windows.Media.ColorConverter]::ConvertFromString("#A7ADB0")
        )
    }
}

function Set-WatchChrome {
    if ($watchExpanded) {
        $watchBorder.BorderBrush = [Windows.Media.SolidColorBrush]::new(
            [Windows.Media.ColorConverter]::ConvertFromString("#3D282D30")
        )
        $watchBorder.Background = [Windows.Media.SolidColorBrush]::new(
            [Windows.Media.ColorConverter]::ConvertFromString("#F2FFFDF8")
        )
        $watchBorder.Effect = New-Object Windows.Media.Effects.DropShadowEffect -Property @{
            BlurRadius = 10
            Color = [Windows.Media.Colors]::Black
            Opacity = 0.12
            ShadowDepth = 1
        }
    } else {
        $watchBorder.BorderBrush = [Windows.Media.Brushes]::Transparent
        $watchBorder.Background = [Windows.Media.Brushes]::Transparent
        $watchBorder.Effect = $null
    }
}

function Refresh-WatchState {
    try {
        $result = $webClient.DownloadString("$ControlUrl/browser/watch") | ConvertFrom-Json
        if ($result.ok) {
            $script:watchEnabled = $result.watch.enabled -eq $true
            Set-WatchAppearance
        }
    } catch {
    }
}

function Send-UserCursor(
    [double]$x,
    [double]$y,
    [bool]$inside,
    [int]$buttons,
    [int]$width,
    [int]$height
) {
    $payload = @{
        x = [Math]::Max(0, [Math]::Min(1, $x))
        y = [Math]::Max(0, [Math]::Min(1, $y))
        inside = $inside
        buttons = $buttons
        pointerType = "mouse"
        canvasWidth = $width
        canvasHeight = $height
        clientTs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    } | ConvertTo-Json -Compress
    try {
        $webClient.UploadString("$ControlUrl/user-cursor", "POST", $payload) | Out-Null
    } catch {
    }
}

function Apply-CursorCommand($command, [switch]$Force) {
    if (
        -not $command -or
        (-not $Force -and "$($command.sequence)" -eq $script:lastCursorSequence)
    ) {
        return
    }
    $script:lastCursorSequence = "$($command.sequence)"
    $script:lastCursorCommand = $command
    if ($command.visible -eq $false) {
        $cursorVisual.Visibility = [Windows.Visibility]::Collapsed
        return
    }
    if ($null -eq $command.x -or $null -eq $command.y) {
        return
    }

    $width = [Math]::Max(1, $cursorWindow.ActualWidth)
    $height = [Math]::Max(1, $cursorWindow.ActualHeight)
    $targetX = [double]$command.x * $width - 3
    $targetY = [double]$command.y * $height - 3
    $duration = if ($command.animate -eq $false) {
        0
    } elseif ($null -ne $command.durationMs) {
        [Math]::Max(140, [Math]::Min(460, [double]$command.durationMs))
    } else {
        220
    }

    if ($duration -le 0) {
        $cursorTranslate.BeginAnimation([Windows.Media.TranslateTransform]::XProperty, $null)
        $cursorTranslate.BeginAnimation([Windows.Media.TranslateTransform]::YProperty, $null)
        $cursorTranslate.X = $targetX
        $cursorTranslate.Y = $targetY
    } else {
        $xAnimation = [Windows.Media.Animation.DoubleAnimation]::new(
            $script:lastCursorTargetX,
            $targetX,
            [TimeSpan]::FromMilliseconds($duration)
        )
        $yAnimation = [Windows.Media.Animation.DoubleAnimation]::new(
            $script:lastCursorTargetY,
            $targetY,
            [TimeSpan]::FromMilliseconds($duration)
        )
        $xAnimation.EasingFunction = New-Object Windows.Media.Animation.CubicEase -Property @{
            EasingMode = [Windows.Media.Animation.EasingMode]::EaseOut
        }
        $yAnimation.EasingFunction = $xAnimation.EasingFunction
        $cursorTranslate.X = $targetX
        $cursorTranslate.Y = $targetY
        $cursorTranslate.BeginAnimation([Windows.Media.TranslateTransform]::XProperty, $xAnimation)
        $cursorTranslate.BeginAnimation([Windows.Media.TranslateTransform]::YProperty, $yAnimation)
    }
    $script:lastCursorTargetX = $targetX
    $script:lastCursorTargetY = $targetY
    $cursorVisual.Visibility = [Windows.Visibility]::Visible

    if ($command.click -eq $true) {
        [Windows.Controls.Canvas]::SetLeft($clickRing, $targetX - 8)
        [Windows.Controls.Canvas]::SetTop($clickRing, $targetY - 8)
        $ringScale.ScaleX = 0.35
        $ringScale.ScaleY = 0.35
        $clickRing.Opacity = 0.85
        $ringDuration = [TimeSpan]::FromMilliseconds(420)
        $opacityAnimation = [Windows.Media.Animation.DoubleAnimation]::new(0.85, 0, $ringDuration)
        $scaleAnimation = [Windows.Media.Animation.DoubleAnimation]::new(0.35, 1.55, $ringDuration)
        $clickRing.BeginAnimation([Windows.UIElement]::OpacityProperty, $opacityAnimation)
        $ringScale.BeginAnimation([Windows.Media.ScaleTransform]::ScaleXProperty, $scaleAnimation)
        $ringScale.BeginAnimation([Windows.Media.ScaleTransform]::ScaleYProperty, $scaleAnimation)
    }

    if ($command.gesture -eq "wiggle") {
        $wiggle = [Windows.Media.Animation.DoubleAnimation]::new(
            -8,
            8,
            [TimeSpan]::FromMilliseconds(105)
        )
        $wiggle.AutoReverse = $true
        $wiggle.RepeatBehavior = [Windows.Media.Animation.RepeatBehavior]::new(2)
        $cursorRotate.BeginAnimation([Windows.Media.RotateTransform]::AngleProperty, $wiggle)
    }
}

$watchBorder.Add_MouseEnter({
    $script:watchExpanded = $true
    $watchLabel.Visibility = [Windows.Visibility]::Visible
    Set-WatchChrome
})
$watchBorder.Add_MouseLeave({
    $script:watchExpanded = $false
    $watchLabel.Visibility = [Windows.Visibility]::Collapsed
    Set-WatchChrome
})
$watchBorder.Add_MouseLeftButtonUp({
    try {
        $payload = @{ enabled = -not $script:watchEnabled } | ConvertTo-Json -Compress
        $result = $webClient.UploadString("$ControlUrl/browser/watch", "POST", $payload) | ConvertFrom-Json
        if ($result.ok) {
            $script:watchEnabled = $result.watch.enabled -eq $true
            Set-WatchAppearance
        }
    } catch {
    }
})

$timer = New-Object Windows.Threading.DispatcherTimer
$timer.Interval = [TimeSpan]::FromMilliseconds(50)
$timer.Add_Tick({
    $root = [IntPtr]::Zero
    $fallbackContent = New-Object SameWindowOverlayNative+RECT
    $hasChromeWindow = [SameWindowOverlayNative]::TryGetChromeContentRect(
        $script:resolvedPid,
        [ref]$root,
        [ref]$fallbackContent
    )
    if (-not $hasChromeWindow -and [DateTime]::UtcNow -ge $script:nextChromeProbeAt) {
        $script:nextChromeProbeAt = [DateTime]::UtcNow.AddMilliseconds(500)
        $script:resolvedPid = Resolve-ChromePid
        if ($script:resolvedPid -gt 0) {
            $hasChromeWindow = [SameWindowOverlayNative]::TryGetChromeContentRect(
                $script:resolvedPid,
                [ref]$root,
                [ref]$fallbackContent
            )
        }
    }
    $isForeground = $hasChromeWindow -and [SameWindowOverlayNative]::ChromeIsForeground($root)
    if (-not $isForeground) {
        if ($script:cursorWindowVisible) {
            $cursorWindow.Hide()
            $script:cursorWindowVisible = $false
        }
        if ($script:watchWindowVisible) {
            $watchWindow.Hide()
            $script:watchWindowVisible = $false
        }
        return
    }

    if (([DateTime]::UtcNow - $script:lastTabProbe).TotalMilliseconds -ge 120) {
        $script:lastTabProbe = [DateTime]::UtcNow
        Sync-ObservedTab $root
    }
    if (([DateTime]::UtcNow - $script:lastGeometryRefresh).TotalMilliseconds -ge 400) {
        $script:lastGeometryRefresh = [DateTime]::UtcNow
        Refresh-PageGeometry
    }
    $windowRect = New-Object SameWindowOverlayNative+RECT
    $hasWindowRect = [SameWindowOverlayNative]::GetWindowRect($root, [ref]$windowRect)
    $content = if ($hasWindowRect) {
        Geometry-ToRect $script:currentGeometry $windowRect
    } else {
        $null
    }
    if (-not $content) {
        $content = $fallbackContent
    }

    $contentWidth = [Math]::Max(1, $content.Right - $content.Left)
    $contentHeight = [Math]::Max(1, $content.Bottom - $content.Top)
    $contentSignature = "$($content.Left),$($content.Top),$contentWidth,$contentHeight"
    if ($contentSignature -ne $script:lastContentSignature) {
        [SameWindowOverlayNative]::SetWindowPos(
            $cursorHandle,
            [IntPtr]::Zero,
            $content.Left,
            $content.Top,
            $contentWidth,
            $contentHeight,
            [SameWindowOverlayNative]::SWP_NOACTIVATE -bor [SameWindowOverlayNative]::SWP_SHOWWINDOW
        ) | Out-Null
        $script:lastContentSignature = $contentSignature
        if ($script:lastCursorCommand) {
            Apply-CursorCommand $script:lastCursorCommand -Force
        }
    }
    if (-not $script:cursorWindowVisible) {
        $cursorWindow.Show()
        $script:cursorWindowVisible = $true
    }

    $dpi = [SameWindowOverlayNative]::GetDpiForWindow($root)
    if ($dpi -le 0) { $dpi = 96 }
    $scale = $dpi / 96.0
    $watchWidthDip = if ($script:watchExpanded) { 92 } else { 38 }
    $watchWidth = [int][Math]::Round($watchWidthDip * $scale)
    $watchHeight = [int][Math]::Round(28 * $scale)
    $windowWidth = [Math]::Max(1, $windowRect.Right - $windowRect.Left)
    $windowHeight = [Math]::Max(1, $windowRect.Bottom - $windowRect.Top)
    $watchX = $windowRect.Right - $watchWidth - [int][Math]::Round(20 * $scale)
    # Anchor the control to Chrome itself, not to the selected page. Bookmark
    # bars and internal pages may change content height, but the dot stays put.
    $watchY = $windowRect.Top + [int][Math]::Round($windowHeight * 0.62)
    $watchY = [Math]::Min(
        $watchY,
        $windowRect.Bottom - $watchHeight - [int][Math]::Round(12 * $scale)
    )
    [SameWindowOverlayNative]::SetWindowPos(
        $watchHandle,
        [IntPtr]::Zero,
        $watchX,
        $watchY,
        $watchWidth,
        $watchHeight,
        [SameWindowOverlayNative]::SWP_NOACTIVATE -bor [SameWindowOverlayNative]::SWP_SHOWWINDOW
    ) | Out-Null
    if (-not $script:watchWindowVisible) {
        $watchWindow.Show()
        $script:watchWindowVisible = $true
    }

    try {
        $cursorWrite = [IO.File]::GetLastWriteTimeUtc($CursorStateFile)
        if ($cursorWrite -ne $script:lastCursorWrite) {
            $script:lastCursorWrite = $cursorWrite
            Apply-CursorCommand ([IO.File]::ReadAllText($CursorStateFile) | ConvertFrom-Json)
        }
    } catch {
    }

    $pointer = New-Object SameWindowOverlayNative+POINT
    if ([SameWindowOverlayNative]::GetCursorPos([ref]$pointer)) {
        $inside = $pointer.X -ge $content.Left -and $pointer.X -lt $content.Right -and
            $pointer.Y -ge $content.Top -and $pointer.Y -lt $content.Bottom
        $x = ($pointer.X - $content.Left) / [double]$contentWidth
        $y = ($pointer.Y - $content.Top) / [double]$contentHeight
        $buttons = 0
        if (([SameWindowOverlayNative]::GetAsyncKeyState(1) -band 0x8000) -ne 0) { $buttons = $buttons -bor 1 }
        if (([SameWindowOverlayNative]::GetAsyncKeyState(2) -band 0x8000) -ne 0) { $buttons = $buttons -bor 2 }
        $pointerSignature = "$($pointer.X),$($pointer.Y),$inside,$buttons"
        if ($pointerSignature -ne $script:lastPointerSignature) {
            $script:lastPointerSignature = $pointerSignature
            Send-UserCursor $x $y $inside $buttons $contentWidth $contentHeight
        }
    }

    if (([DateTime]::UtcNow - $script:lastWatchRefresh).TotalMilliseconds -ge 1000) {
        $script:lastWatchRefresh = [DateTime]::UtcNow
        Refresh-WatchState
    }
})

$cursorWindow.Add_Closed({
    $timer.Stop()
    $watchWindow.Close()
})

Set-WatchAppearance
Set-WatchChrome
$timer.Start()
[Windows.Threading.Dispatcher]::Run()
