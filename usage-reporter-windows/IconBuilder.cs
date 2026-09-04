using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.IO;

internal static class IconBuilder {
    private static void Main(string[] args) {
        if (args.Length != 3) throw new ArgumentException("IconBuilder source.png output.png output.ico");
        using (Bitmap source = new Bitmap(args[0]))
        using (Bitmap keyed = RemoveLightBackground(source))
        using (Bitmap final = CropAndResize(keyed, 512, 32)) {
            final.Save(args[1], ImageFormat.Png);
            WriteIco(final, args[2], new[] { 256, 128, 64, 48, 32, 24, 16 });
        }
    }

    private static Bitmap RemoveLightBackground(Bitmap source) {
        Bitmap output = new Bitmap(source.Width, source.Height, PixelFormat.Format32bppArgb);
        for (int y = 0; y < source.Height; y++) for (int x = 0; x < source.Width; x++) {
            Color pixel = source.GetPixel(x, y); int max = Math.Max(pixel.R, Math.Max(pixel.G, pixel.B)); int min = Math.Min(pixel.R, Math.Min(pixel.G, pixel.B));
            output.SetPixel(x, y, min > 210 && max - min < 30 ? Color.Transparent : Color.FromArgb(255, pixel.R, pixel.G, pixel.B));
        }
        return output;
    }

    private static Bitmap CropAndResize(Bitmap source, int size, int padding) {
        int left = source.Width, top = source.Height, right = -1, bottom = -1;
        for (int y = 0; y < source.Height; y++) for (int x = 0; x < source.Width; x++) if (source.GetPixel(x, y).A > 0) { left = Math.Min(left, x); top = Math.Min(top, y); right = Math.Max(right, x); bottom = Math.Max(bottom, y); }
        if (right < left || bottom < top) throw new InvalidDataException("No icon pixels remain after background removal.");
        int width = right - left + 1, height = bottom - top + 1, available = size - padding * 2;
        double scale = Math.Min(available / (double)width, available / (double)height); int targetWidth = Math.Max(1, (int)Math.Round(width * scale)), targetHeight = Math.Max(1, (int)Math.Round(height * scale));
        Bitmap output = new Bitmap(size, size, PixelFormat.Format32bppArgb);
        using (Graphics graphics = Graphics.FromImage(output)) {
            graphics.Clear(Color.Transparent); graphics.CompositingMode = CompositingMode.SourceCopy; graphics.CompositingQuality = CompositingQuality.HighQuality;
            graphics.InterpolationMode = InterpolationMode.HighQualityBicubic; graphics.PixelOffsetMode = PixelOffsetMode.HighQuality; graphics.SmoothingMode = SmoothingMode.HighQuality;
            graphics.DrawImage(source, new Rectangle((size - targetWidth) / 2, (size - targetHeight) / 2, targetWidth, targetHeight), new Rectangle(left, top, width, height), GraphicsUnit.Pixel);
        }
        return output;
    }

    private static void WriteIco(Bitmap source, string path, int[] sizes) {
        List<byte[]> images = new List<byte[]>();
        foreach (int size in sizes) using (Bitmap resized = new Bitmap(size, size, PixelFormat.Format32bppArgb)) {
            using (Graphics graphics = Graphics.FromImage(resized)) { graphics.Clear(Color.Transparent); graphics.CompositingMode = CompositingMode.SourceCopy; graphics.InterpolationMode = InterpolationMode.HighQualityBicubic; graphics.DrawImage(source, 0, 0, size, size); }
            using (MemoryStream memory = new MemoryStream()) { resized.Save(memory, ImageFormat.Png); images.Add(memory.ToArray()); }
        }
        using (BinaryWriter writer = new BinaryWriter(File.Create(path))) {
            writer.Write((ushort)0); writer.Write((ushort)1); writer.Write((ushort)images.Count); int offset = 6 + images.Count * 16;
            for (int i = 0; i < images.Count; i++) { int size = sizes[i]; writer.Write((byte)(size == 256 ? 0 : size)); writer.Write((byte)(size == 256 ? 0 : size)); writer.Write((byte)0); writer.Write((byte)0); writer.Write((ushort)1); writer.Write((ushort)32); writer.Write(images[i].Length); writer.Write(offset); offset += images[i].Length; }
            foreach (byte[] image in images) writer.Write(image);
        }
    }
}
